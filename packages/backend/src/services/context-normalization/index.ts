import { memoryLogger } from '../logger.js';
import { extractExpertRoutingSessionId } from '../expert-router/session-binding.js';
import { contextNormalizationRepository, resolveContextBindingScope } from '../../db/repositories/context-normalization.repository.js';
import {
  computeContextFingerprint,
  type NormalizationProtocol,
} from './fingerprint.js';
import {
  cleanAnthropicMessages,
  cleanGeminiContents,
  cleanOpenAiMessages,
  cleanResponsesInput,
  type CleanStats,
} from './cleaner.js';
import { detectUnfinishedToolLoop, validateSequence } from './tool-loop.js';

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Idle sliding TTL for a context binding (renewed on every same-fingerprint hit). */
const DEFAULT_IDLE_TTL_SECONDS = parsePositiveNumber(
  process.env.CONTEXT_NORMALIZATION_IDLE_TTL_SECONDS,
  30 * 60
);
/** Absolute cap on a binding's lifetime regardless of activity. */
const DEFAULT_ABSOLUTE_TTL_SECONDS = parsePositiveNumber(
  process.env.CONTEXT_NORMALIZATION_ABSOLUTE_TTL_SECONDS,
  24 * 3600
);
const EVENT_RETENTION_MS = parsePositiveNumber(
  process.env.CONTEXT_NORMALIZATION_EVENT_RETENTION_DAYS,
  30
) * 24 * 3600 * 1000;

export type CleaningDecision =
  | 'same'
  | 'first'
  | 'cleaned'
  | 'blocked_tool_loop'
  | 'blocked_invalid_sequence'
  | 'skipped_no_session'
  | 'skipped_db_error'
  | 'skipped_disabled';

export interface NormalizeContextArgs {
  protocol: NormalizationProtocol;
  request: any;
  body: any;
  providerId: string;
  /** Final value of body.model after model-suffix resolution (FR-2). */
  model: string;
  forcedReasoningEffort?: string;
  virtualKey: any;
}

export interface NormalizeContextResult {
  decision: CleaningDecision;
  cleanedBlocks?: number;
  cleanedChars?: number;
  blockReason?: string;
}

const NO_CHANGE: Pick<NormalizeContextResult, 'cleanedBlocks' | 'cleanedChars'> = {
  cleanedBlocks: 0,
  cleanedChars: 0,
};

function cloneSequence(value: any[]): any[] {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function cleanSequence(
  protocol: NormalizationProtocol,
  body: any
): { field: 'input' | 'messages' | 'contents' | null; payload: any[] | null; stats: CleanStats } {
  const empty = { field: null, payload: null, stats: { cleanedBlocks: 0, cleanedChars: 0 } };
  if (!body || typeof body !== 'object') return empty;

  if (protocol === 'openai') {
    if (Array.isArray(body.input)) {
      const { payload, stats } = cleanResponsesInput(cloneSequence(body.input));
      return { field: 'input', payload, stats };
    }
    if (Array.isArray(body.messages)) {
      const { payload, stats } = cleanOpenAiMessages(cloneSequence(body.messages));
      return { field: 'messages', payload, stats };
    }
    return empty;
  }

  if (protocol === 'anthropic') {
    if (!Array.isArray(body.messages)) return empty;
    const { payload, stats } = cleanAnthropicMessages(cloneSequence(body.messages));
    return { field: 'messages', payload, stats };
  }

  if (!Array.isArray(body.contents)) return empty;
  const { payload, stats } = cleanGeminiContents(cloneSequence(body.contents));
  return { field: 'contents', payload, stats };
}

/**
 * Orchestrate model-switch context normalization (WS-004).
 *
 * Decision contract (Shared Contracts):
 * - `same` / `first` / `skipped_*`: request body is untouched (zero-change passthrough).
 * - `cleaned`: reasoning state stripped from history in place; binding updated.
 * - `blocked_*`: request must NOT be forwarded upstream; binding is left unchanged.
 *
 * Fail-open policy: DB errors skip normalization and passthrough (Edge Cases).
 */
export async function normalizeContextForSwitch(args: NormalizeContextArgs): Promise<NormalizeContextResult> {
  const { protocol, request, body, providerId, model, forcedReasoningEffort, virtualKey } = args;

  if (virtualKey?.context_normalization_enabled !== 1) {
    return { decision: 'skipped_disabled', ...NO_CHANGE };
  }

  const sessionId = extractExpertRoutingSessionId(request);
  if (!sessionId) {
    memoryLogger.debug('上下文规范化: 无 session_id，跳过', 'CtxNormalize');
    return { decision: 'skipped_no_session', ...NO_CHANGE };
  }

  const targetFingerprint = computeContextFingerprint({
    protocol,
    providerId,
    model,
    body,
    forcedReasoningEffort,
  });

  const scope = resolveContextBindingScope(virtualKey?.id);
  const key = { virtualKeyScope: scope, sessionId };
  const virtualKeyId = virtualKey?.id ?? null;

  // Read + renew the active binding. Fail-open on DB errors (Edge Cases).
  let binding: Awaited<ReturnType<typeof contextNormalizationRepository.getActiveBinding>>;
  try {
    binding = await contextNormalizationRepository.getActiveBinding(key, DEFAULT_IDLE_TTL_SECONDS);
  } catch (e: any) {
    memoryLogger.error(
      `上下文规范化读取 binding 失败(已跳过,fail-open): ${e?.message || e}`,
      'CtxNormalize'
    );
    return { decision: 'skipped_db_error', ...NO_CHANGE };
  }

  // First request for this session: record the fingerprint, no cleaning (FR-5).
  // If a concurrent writer already persisted a different fingerprint, fall through
  // and treat this request as a switch.
  if (!binding) {
    try {
      const created = await contextNormalizationRepository.createBinding(
        key,
        targetFingerprint,
        protocol,
        DEFAULT_IDLE_TTL_SECONDS,
        DEFAULT_ABSOLUTE_TTL_SECONDS
      );
      if (created.fingerprint === targetFingerprint) {
        memoryLogger.debug(
          `上下文规范化: 首请求记录指纹 | session=${sessionId.slice(0, 8)}... | model=${model}`,
          'CtxNormalize'
        );
        return { decision: 'first', ...NO_CHANGE };
      }
      binding = created;
    } catch (e: any) {
      memoryLogger.error(
        `上下文规范化首请求记录失败(已跳过,fail-open): ${e?.message || e}`,
        'CtxNormalize'
      );
      return { decision: 'skipped_db_error', ...NO_CHANGE };
    }
  }

  if (!binding) {
    return { decision: 'skipped_db_error', ...NO_CHANGE };
  }

  // Same fingerprint: zero-change passthrough (AC-1, FR-18).
  if (binding.fingerprint === targetFingerprint) {
    return { decision: 'same', ...NO_CHANGE };
  }

  // Switch detected — clean, validate, then update binding.
  memoryLogger.info(
    `上下文规范化: 检测到模型切换 | session=${sessionId.slice(0, 8)}... | ` +
      `protocol=${protocol} | model=${model} | src_version=${binding.context_version}`,
    'CtxNormalize'
  );

  // FR-13: block when the history tail has an unfinished tool loop.
  if (detectUnfinishedToolLoop(protocol, body)) {
    const reason = '当前工具循环未完成，无法切换模型';
    memoryLogger.warn(`上下文规范化: 阻止切换(未完成工具循环) | session=${sessionId.slice(0, 8)}...`, 'CtxNormalize');
    await safeInsertEvent({
      virtualKeyId,
      sessionId,
      protocol,
      sourceFingerprint: binding.fingerprint,
      targetFingerprint,
      sourceContextVersion: binding.context_version,
      targetContextVersion: binding.context_version,
      strategy: 'blocked_tool_loop',
      cleanedBlocks: 0,
      cleanedChars: 0,
      reason,
    });
    return { decision: 'blocked_tool_loop', ...NO_CHANGE, blockReason: reason };
  }

  const cleaned = cleanSequence(protocol, body);

  // FR-10 / FR-11: block when cleaning would produce an illegal message sequence.
  if (cleaned.payload && !validateSequence(protocol, cleaned.payload)) {
    const reason = '清洗后将产生非法消息序列(角色交替破坏)，已阻止切换';
    memoryLogger.warn(`上下文规范化: 阻止切换(非法序列) | session=${sessionId.slice(0, 8)}...`, 'CtxNormalize');
    await safeInsertEvent({
      virtualKeyId,
      sessionId,
      protocol,
      sourceFingerprint: binding.fingerprint,
      targetFingerprint,
      sourceContextVersion: binding.context_version,
      targetContextVersion: binding.context_version,
      strategy: 'blocked_invalid_sequence',
      cleanedBlocks: cleaned.stats.cleanedBlocks,
      cleanedChars: cleaned.stats.cleanedChars,
      reason,
    });
    return {
      decision: 'blocked_invalid_sequence',
      cleanedBlocks: cleaned.stats.cleanedBlocks,
      cleanedChars: cleaned.stats.cleanedChars,
      blockReason: reason,
    };
  }

  if (cleaned.field && cleaned.payload) {
    body[cleaned.field] = cleaned.payload;
  }
  const stats = cleaned.stats;

  // Cleaning succeeded: persist the new fingerprint + bumped version.
  let updatedVersion = binding.context_version + 1;
  try {
    const updated = await contextNormalizationRepository.updateBindingOnSwitch(
      key,
      targetFingerprint,
      protocol,
      DEFAULT_IDLE_TTL_SECONDS
    );
    if (updated) updatedVersion = updated.context_version;
  } catch (e: any) {
    memoryLogger.error(
      `上下文规范化更新 binding 失败(已清洗但状态未持久化): ${e?.message || e}`,
      'CtxNormalize'
    );
  }

  memoryLogger.info(
    `上下文规范化: 切换清洗完成 | session=${sessionId.slice(0, 8)}... | ` +
      `删除 reasoning 块=${stats.cleanedBlocks} | 字符=${stats.cleanedChars} | 新版本=${updatedVersion}`,
    'CtxNormalize'
  );

  await safeInsertEvent({
    virtualKeyId,
    sessionId,
    protocol,
    sourceFingerprint: binding.fingerprint,
    targetFingerprint,
    sourceContextVersion: binding.context_version,
    targetContextVersion: updatedVersion,
    strategy: 'cleaned',
    cleanedBlocks: stats.cleanedBlocks,
    cleanedChars: stats.cleanedChars,
  });

  return { decision: 'cleaned', cleanedBlocks: stats.cleanedBlocks, cleanedChars: stats.cleanedChars };
}

async function safeInsertEvent(event: Parameters<typeof contextNormalizationRepository.insertSwitchEvent>[0]): Promise<void> {
  try {
    await contextNormalizationRepository.insertSwitchEvent(event);
  } catch (e: any) {
    memoryLogger.error(`上下文规范化审计事件写入失败(已跳过): ${e?.message || e}`, 'CtxNormalize');
  }
}

export function buildBlockedSwitchResponse(
  protocol: NormalizationProtocol,
  reason: string
): { status: 400; body: unknown } {
  if (protocol === 'openai') {
    return {
      status: 400,
      body: {
        error: {
          message: reason,
          type: 'invalid_request_error',
          param: null,
          code: 'context_switch_blocked',
        },
      },
    };
  }
  if (protocol === 'anthropic') {
    return {
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: reason,
        },
      },
    };
  }
  return {
    status: 400,
    body: {
      error: {
        message: reason,
        code: 400,
        status: 'INVALID_ARGUMENT',
      },
    },
  };
}

export type ApplyContextNormalizationResult =
  | { blocked: false }
  | { blocked: true; status: 400; body: unknown };

export async function applyContextNormalization(
  args: NormalizeContextArgs
): Promise<ApplyContextNormalizationResult> {
  if (args.virtualKey?.context_normalization_enabled !== 1) {
    return { blocked: false };
  }

  const result = await normalizeContextForSwitch(args);
  if (result.decision === 'blocked_tool_loop' || result.decision === 'blocked_invalid_sequence') {
    return {
      blocked: true,
      ...buildBlockedSwitchResponse(args.protocol, result.blockReason || 'Context switch blocked'),
    };
  }
  return { blocked: false };
}

export function startContextNormalizationCleanup(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const run = async () => {
    try {
      const expired = await contextNormalizationRepository.cleanupExpiredBindings();
      if (expired > 0) {
        memoryLogger.info(`上下文规范化 binding 清理 | expired=${expired}`, 'CtxNormalize');
      }
      const events = await contextNormalizationRepository.cleanupOldSwitchEvents(
        Date.now(),
        EVENT_RETENTION_MS
      );
      if (events > 0) {
        memoryLogger.info(`上下文规范化审计事件清理 | deleted=${events}`, 'CtxNormalize');
      }
    } catch (e: any) {
      memoryLogger.warn(`上下文规范化清理失败: ${e?.message || e}`, 'CtxNormalize');
    }
  };
  return setInterval(run, intervalMs);
}
