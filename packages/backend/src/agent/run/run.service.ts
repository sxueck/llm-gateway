import { nanoid } from 'nanoid';
import { encryptText, decryptText, getMasterKey } from '../snapshot/encryption.js';
import { resolvePlugin, PluginStoreError, type ResolvedPlugin } from '../plugins/store.js';
import { modelDb, agentSearchRunDb, agentSearchUsageDb } from '../../db/index.js';
import { generateServiceToken } from './service-token.js';
import {
  buildWorkspace,
  getOwnedSnapshot,
  touchSnapshot,
  SNAPSHOT_RETENTION_MS,
} from '../snapshot/snapshot.service.js';
import { memoryLogger } from '../../services/logger.js';
import type { AgentSearchRun } from '../../db/types.js';
import type {
  CreateSearchRunRequest,
  StructuredSearchResult,
} from '@llm-gateway/shared';

export type RunOperationError = {
  code:
    | 'unknown_plugin'
    | 'plugin_revoked'
    | 'invalid_run_param'
    | 'snapshot_not_ready'
    | 'snapshot_expired'
    | 'model_profile_not_configured'
    | 'model_profile_override_forbidden'
    | 'not_found'
    | 'invalid_state';
  message: string;
};

export class RunError extends Error {
  constructor(public readonly opError: RunOperationError) {
    super(opError.message);
  }
}

/**
 * run 参数按插件声明逐项校验：键必须声明、值必须命中枚举；未声明 optional 的
 * 参数缺省时报错。返回可直接下发给 worker 的规范化参数表。
 */
export function validateRunParams(
  manifest: {
    id: string;
    role?: { params?: readonly {
      key: string;
      values: readonly string[];
      optional: boolean;
    }[] };
  },
  params: Record<string, string>,
): { ok: true; params: Record<string, string> } | { ok: false; message: string } {
  const defs = manifest.role?.params ?? [];
  const defByKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(params)) {
    const def = defByKey.get(key);
    if (!def) {
      return {
        ok: false,
        message: `plugin ${manifest.id} does not declare run param "${key}"`,
      };
    }
    if (!def.values.includes(params[key])) {
      return {
        ok: false,
        message: `run param "${key}" must be one of: ${def.values.join(', ')}`,
      };
    }
  }
  for (const def of defs) {
    if (!def.optional && !(def.key in params)) {
      return {
        ok: false,
        message: `run param "${def.key}" is required by plugin ${manifest.id}`,
      };
    }
  }
  const picked: Record<string, string> = {};
  for (const def of defs) {
    if (params[def.key] !== undefined) picked[def.key] = params[def.key];
  }
  return { ok: true, params: picked };
}

export async function validateRunInputs(principal: { virtualKeyId: string }, body: CreateSearchRunRequest): Promise<{
  plugin: ResolvedPlugin;
  profile: string;
  /** 通过插件声明校验的规范化 run 参数（未知键/非法值已拒绡）。 */
  params: Record<string, string>;
  /** 快照源解析出的 head_commit（快照未携带时为 null），随 run 落库为 resolved_commit。 */
  resolvedCommit: string | null;
}> {
  let plugin;
  try {
    plugin = await resolvePlugin(body.plugin.id, body.plugin.version);
  } catch (e) {
    // resolvePlugin 只可能抛 plugin_revoked；其余 store 错误码属于发布链路，原样上抛
    if (e instanceof PluginStoreError && e.code === 'plugin_revoked') {
      throw new RunError({ code: e.code, message: e.message });
    }
    throw e;
  }
  if (!plugin) {
    throw new RunError({
      code: 'unknown_plugin',
      message: `plugin ${body.plugin.id}@${body.plugin.version} is not published`,
    });
  }

  let profile = plugin.manifest.model_policy.profile;
  const override = body.options?.model_profile;
  if (override && override !== profile) {
    if (!plugin.manifest.model_policy.allow_client_override) {
      throw new RunError({
        code: 'model_profile_override_forbidden',
        message: `plugin ${plugin.manifest.id} does not allow client model_profile override`,
      });
    }
    profile = override;
  }
  const model = await modelDb.getByName(profile);
  if (!model) {
    throw new RunError({
      code: 'model_profile_not_configured',
      message: `model profile "${profile}" is not configured as an enabled gateway model`,
    });
  }

  const paramsResult = validateRunParams(
    plugin.manifest,
    body.options?.params ?? {},
  );
  if (!paramsResult.ok) {
    throw new RunError({ code: 'invalid_run_param', message: paramsResult.message });
  }

  let resolvedCommit: string | null = null;
  if (body.source.type === 'snapshot') {
    // 属主校验在 service 内（不泄露存在性）
    const snapshot = await getOwnedSnapshot(body.source.snapshot_id, principal);
    if (snapshot.status !== 'ready') {
      throw new RunError({
        code: 'snapshot_not_ready',
        message: `snapshot ${snapshot.id} is ${snapshot.status}`,
      });
    }
    if (Date.now() > snapshot.expires_at) {
      throw new RunError({ code: 'snapshot_expired', message: `snapshot ${snapshot.id} expired` });
    }
    // head_commit 在快照创建时已固定，此处直接解析入 run；快照未携带时保持 null。
    resolvedCommit = snapshot.head_commit;
  }

  return { plugin, profile, params: paramsResult.params, resolvedCommit };
}

export async function persistNewRun(params: {
  principal: { virtualKeyId: string };
  body: CreateSearchRunRequest;
  plugin: { manifest: { id: string; version: string }; digest: string };
  profile: string;
  /** 通过插件声明校验的规范化 run 参数；值域为插件枚举，非自由文本，明文落库。 */
  params?: Record<string, string>;
  resolvedCommit: string | null;
}): Promise<{ run: AgentSearchRun; serviceToken: string; query: string }> {
  const { principal, body, plugin, profile } = params;
  const id = `asr_${nanoid(21)}`;
  const now = Date.now();
  const masterKey = await getMasterKey();
  const serviceToken = generateServiceToken();

  const run = await agentSearchRunDb.create({
    id,
    user_id: principal.virtualKeyId,
    virtual_key_id: principal.virtualKeyId,
    plugin_id: plugin.manifest.id,
    plugin_version: plugin.manifest.version,
    plugin_digest: plugin.digest,
    source_type: body.source.type,
    snapshot_id: body.source.type === 'snapshot' ? body.source.snapshot_id : null,
    public_git_url_encrypted: null,
    requested_ref: null,
    resolved_commit: params.resolvedCommit,
    query_encrypted: encryptText(masterKey, body.query),
    model_profile: profile,
    options_json: JSON.stringify({ params: params.params ?? {} }),
    status: 'queued',
    error_code: null,
    error_message: null,
    service_token_hash: serviceToken.hash,
    created_at: now,
    expires_at: now + SNAPSHOT_RETENTION_MS,
  });
  return { run, serviceToken: serviceToken.token, query: body.query };
}

export async function getOwnedRun(
  runId: string,
  principal: { virtualKeyId: string },
): Promise<AgentSearchRun> {
  const run = await agentSearchRunDb.getById(runId);
  if (!run || run.virtual_key_id !== principal.virtualKeyId) {
    throw new RunError({ code: 'not_found', message: `run ${runId} not found` });
  }
  return run;
}

export async function readRunQuery(run: AgentSearchRun): Promise<string> {
  const masterKey = await getMasterKey();
  return decryptText(masterKey, run.query_encrypted);
}

export async function readRunResult(run: AgentSearchRun): Promise<StructuredSearchResult | null> {
  if (!run.result_encrypted) return null;
  const masterKey = await getMasterKey();
  try {
    return JSON.parse(decryptText(masterKey, run.result_encrypted));
  } catch {
    memoryLogger.warn(`Run ${run.id} result unreadable`, 'AgentSearch');
    return null;
  }
}

export async function getRunUsage(runId: string) {
  return agentSearchUsageDb.getByRunId(runId);
}

/** 为 run 准备 workspace（解密重建快照），返回 workspace 根。 */
export async function prepareWorkspace(run: AgentSearchRun, workspaceRoot: string): Promise<void> {
  if (run.source_type !== 'snapshot' || !run.snapshot_id) {
    throw new RunError({ code: 'invalid_state', message: 'run has no snapshot source' });
  }
  await buildWorkspace(run.snapshot_id, workspaceRoot);
  // 滑动 24h 只在这里续期：快照被 run 真正消费才算“在用”，仅上传不检索
  // 不应把到期时间无限推迟。续期失败不影响已缓存 workspace 的本次检索。
  try {
    await touchSnapshot(run.snapshot_id);
  } catch (e) {
    memoryLogger.warn(`snapshot ${run.snapshot_id} expiry renewal failed: ${e}`, 'AgentSearch');
  }
}
