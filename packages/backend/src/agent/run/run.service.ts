import { nanoid } from 'nanoid';
import { encryptText, decryptText, getMasterKey } from '../snapshot/encryption.js';
import { resolvePlugin } from '../plugins/registry.js';
import { modelDb, agentSearchRunDb, agentSearchUsageDb } from '../../db/index.js';
import { generateServiceToken } from './service-token.js';
import {
  buildWorkspace,
  getOwnedSnapshot,
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

export async function validateRunInputs(principal: { virtualKeyId: string }, body: CreateSearchRunRequest) {
  const plugin = resolvePlugin(body.plugin.id, body.plugin.version);
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
  }

  return { plugin, profile };
}

export async function persistNewRun(params: {
  principal: { virtualKeyId: string };
  body: CreateSearchRunRequest;
  plugin: { manifest: { id: string; version: string }; digest: string };
  profile: string;
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
    resolved_commit: null,
    query_encrypted: encryptText(masterKey, body.query),
    model_profile: profile,
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
}
