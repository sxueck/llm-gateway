import { nanoid } from 'nanoid';
import type { FastifyRequest } from 'fastify';
import { promptSampleDb } from '../db/index.js';
import type { VirtualKey } from '../types/index.js';
import { SignalBuilder } from './expert-router/preprocess/index.js';
import { maskRequestBodyInPlace } from './pii-protection-service.js';
import { memoryLogger } from './logger.js';

type PromptCaptureProtocol = 'openai' | 'anthropic' | 'gemini';

function copyRequestBody(body: unknown): any {
  return body === undefined ? {} : structuredClone(body);
}

// 匹配行首的对话角色标记（"User:" / "Assistant:" / "[1] User:" / "### Human" 等）。
// \b + [:：\-] 边界避免误伤普通文本。
const CONVERSATION_ROLE_RE =
  /^(?:\[\d+\]\s*|#+\s*|[-*]\s*|[-=]{3,}\s*)?(user|human|you|assistant|ai|model|system|developer)\b\s*[:：\-]\s*/i;

const USER_ROLE_RE = /^(user|human|you)$/i;
const ASSISTANT_ROLE_RE = /^(assistant|ai|model)$/i;

// 客户端把多轮对话（含 assistant 回复）塞进单条 user message 时，剥离出
// 最后一段 user 段；无对话结构（单轮提问）则原样返回。
function stripConversationTurns(text: string): string {
  if (!text) return '';

  const lines = text.split(/\r?\n/);
  // 仅处理以角色标记开头的完整粘贴对话，避免将用户提问中引用的对话截断。
  const firstContentLine = lines.find(line => line.trim());
  if (!firstContentLine || !CONVERSATION_ROLE_RE.test(firstContentLine)) return text;

  type Segment = { role: string; text: string[] };
  const segments: Segment[] = [];
  let current: Segment | null = null;

  for (const line of lines) {
    const m = line.match(CONVERSATION_ROLE_RE);
    if (m) {
      const rest = line.slice(m[0].length).trim();
      current = { role: m[1].toLowerCase(), text: rest ? [rest] : [] };
      segments.push(current);
    } else if (current) {
      current.text.push(line);
    } else {
      // 角色标记之前的前导文本兜底为 user 段。
      current = { role: 'user', text: [line] };
      segments.push(current);
    }
  }

  const roleSegments = segments.filter(s =>
    USER_ROLE_RE.test(s.role) || ASSISTANT_ROLE_RE.test(s.role) || /^(system|developer)$/i.test(s.role)
  );
  if (roleSegments.length === 0) return text;

  const hasAssistant = roleSegments.some(s => ASSISTANT_ROLE_RE.test(s.role));
  const userSegments = roleSegments.filter(s => USER_ROLE_RE.test(s.role));
  // 无 assistant 段或无 user 段 → 视为单轮提问，原样返回避免误伤。
  if (!hasAssistant || userSegments.length === 0) return text;

  const lastUser = userSegments[userSegments.length - 1];
  const result = lastUser.text.join('\n').trim();
  return result || text;
}

export async function capturePromptSample(
  virtualKey: Pick<VirtualKey, 'id' | 'prompt_capture_enabled' | 'pii_protection_enabled'>,
  request: Pick<FastifyRequest, 'body'>,
  protocol: PromptCaptureProtocol
): Promise<void> {
  if (virtualKey.prompt_capture_enabled !== 1) return;

  const body = copyRequestBody(request.body);
  if (virtualKey.pii_protection_enabled === 1) {
    maskRequestBodyInPlace(body, true);
  }

  const signal = await SignalBuilder.buildRoutingSignal(
    { body, protocol },
    { strip_tools: true, strip_files: true, strip_system_prompt: true }
  );
  // SignalBuilder 不感知单条 user message 内的对话轮次结构，二次剥离最后一段 user 段。
  const intentText = stripConversationTurns(signal.intentText).trim();
  if (!intentText) return;

  await promptSampleDb.create({
    id: nanoid(),
    virtual_key_id: virtualKey.id,
    model: typeof body.model === 'string' ? body.model : 'unknown',
    protocol,
    intent_text: intentText,
    prompt_tokens: signal.stats?.promptTokens || 0,
    intent_truncated: signal.stats?.intentTruncated ? 1 : 0,
    created_at: Date.now(),
  });
}

export function capturePromptSampleAsync(
  virtualKey: Pick<VirtualKey, 'id' | 'prompt_capture_enabled' | 'pii_protection_enabled'>,
  request: Pick<FastifyRequest, 'body'>,
  protocol: PromptCaptureProtocol
): void {
  capturePromptSample(virtualKey, request, protocol).catch((error) => {
    memoryLogger.warn(
      `Prompt sample capture failed: ${error instanceof Error ? error.message : String(error)}`,
      'PromptCapture'
    );
  });
}
