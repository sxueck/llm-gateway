import { createHash } from 'crypto';
import { mkdir, rm, writeFile, readFile, stat } from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import {
  SNAPSHOT_MAX_TOTAL_BYTES,
  isForbiddenSnapshotPath,
  isSafeSnapshotPath,
  type CreateSnapshotRequest,
  type SnapshotManifest,
} from '@llm-gateway/shared';
import { repositorySnapshotDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import type { RepositorySnapshot } from '../../db/types.js';
import {
  decryptBlob,
  decryptText,
  encryptBlob,
  encryptText,
  generateDek,
  getMasterKey,
  unwrapDek,
  wrapDek,
} from './encryption.js';

export const SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;

export function snapshotStorageRoot(): string {
  return process.env.AGENT_SNAPSHOT_STORAGE_DIR || path.join(process.cwd(), 'data', 'agent-snapshots');
}

export type SnapshotOperationError = {
  code:
    | 'not_found'
    | 'forbidden'
    | 'invalid_state'
    | 'expired'
    | 'invalid_manifest'
    | 'unknown_file'
    | 'hash_mismatch'
    | 'incomplete';
  message: string;
};

export class SnapshotError extends Error {
  constructor(public readonly opError: SnapshotOperationError) {
    super(opError.message);
  }
}

function snapshotDir(id: string): string {
  return path.join(snapshotStorageRoot(), id);
}

function objectPath(id: string, sha256: string): string {
  // sha256 已由 schema 保证为 64 位 hex，此处再防御一次，杜绝路径注入。
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid object hash');
  return path.join(snapshotDir(id), 'objects', `${sha256}.enc`);
}

/**
 * Phase 1 以 virtual key 作为快照的属主主体；user_id 列冗余存 virtual key id，
 * 多用户体系落地时再回填真实用户。
 */
export interface SnapshotPrincipal {
  virtualKeyId: string;
}

/**
 * 增量上传的复用结果：`reused` 中的路径已在新快照目录下重新加密落盘，
 * 客户端无需再 PUT；`missing` 是需要上传的全集（含 base 中不存在的条目）。
 */
export interface SnapshotReuseResult {
  reused: string[];
  missing: string[];
}

export async function createSnapshot(
  principal: SnapshotPrincipal,
  req: CreateSnapshotRequest,
): Promise<{ row: RepositorySnapshot; reuse: SnapshotReuseResult }> {
  const manifest = req.manifest;

  const seen = new Set<string>();
  const forbidden: string[] = [];
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (!isSafeSnapshotPath(file.path)) {
      throw new SnapshotError({
        code: 'invalid_manifest',
        message: `unsafe manifest path: ${file.path}`,
      });
    }
    if (seen.has(file.path)) {
      throw new SnapshotError({
        code: 'invalid_manifest',
        message: `duplicate manifest path: ${file.path}`,
      });
    }
    seen.add(file.path);
    if (isForbiddenSnapshotPath(file.path)) forbidden.push(file.path);
    totalBytes += file.size;
  }
  if (forbidden.length > 0) {
    throw new SnapshotError({
      code: 'invalid_manifest',
      message: `manifest contains platform-forbidden paths: ${forbidden.slice(0, 5).join(', ')}`,
    });
  }
  if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) {
    throw new SnapshotError({
      code: 'invalid_manifest',
      message: `snapshot total size ${totalBytes} exceeds limit ${SNAPSHOT_MAX_TOTAL_BYTES}`,
    });
  }

  const id = `snap_${nanoid(21)}`;
  const dek = generateDek();
  const masterKey = await getMasterKey();
  const now = Date.now();

  // 复用必须先于建行完成：任何失败都不留下一个半成品快照行。
  const reuse = await reuseObjects(principal, req.base_snapshot_id, manifest.files, id, dek);

  let row: RepositorySnapshot;
  try {
    row = await repositorySnapshotDb.create({
      id,
      user_id: principal.virtualKeyId,
      virtual_key_id: principal.virtualKeyId,
      source_type: req.source,
      display_name: req.repository.display_name,
      git_remote: req.repository.git_remote ?? null,
      head_commit: req.repository.head_commit ?? null,
      manifest_encrypted: encryptText(dek, JSON.stringify(manifest)),
      dek_encrypted: wrapDek(masterKey, dek),
      file_count: manifest.files.length,
      total_size: totalBytes,
      storage_prefix: id,
      status: 'uploading',
      created_at: now,
      expires_at: now + SNAPSHOT_RETENTION_MS,
    });
  } catch (e) {
    // 复用先于建行写盘；建行失败时必须回收，否则无行目录不在任何清理路径内。
    await rm(snapshotDir(id), { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }

  await mkdir(path.join(snapshotDir(id), 'objects'), { recursive: true });
  memoryLogger.info(
    `Snapshot ${id} created (${manifest.files.length} files, ${reuse.reused.length} reused from ${req.base_snapshot_id})`,
    'AgentSearch',
  );
  return { row, reuse };
}

/** base 只是复用提示：任何不可用形态都降级为全量上传，而非让本次同步失败。 */
async function resolveUsableBase(
  baseSnapshotId: string,
  principal: SnapshotPrincipal,
): Promise<RepositorySnapshot | null> {
  const row = await repositorySnapshotDb.getById(baseSnapshotId);
  // 不存在、已删除、跨密钥走同一分支，响应上不可区分（不泄露存在性）
  if (!row || row.status === 'deleted' || row.virtual_key_id !== principal.virtualKeyId) {
    memoryLogger.warn(
      `base snapshot ${baseSnapshotId} unusable; falling back to a full upload`,
      'AgentSearch',
    );
    return null;
  }
  if (row.status !== 'ready') {
    memoryLogger.warn(
      `base snapshot ${baseSnapshotId} is ${row.status}; falling back to a full upload`,
      'AgentSearch',
    );
    return null;
  }
  return row;
}

/**
 * 一快照一 DEK：复用只能按字节搬运，不能跨快照共享密文——否则 base 的 DEK
 * 泄漏会连带解开所有后继快照。这里用 base DEK 解密、新 DEK 重加密，并在写盘
 * 前复验明文 hash，使“base 对象被篡改”无法被静默继承。
 *
 * 成本上限：base 中命中 sha256 的条目全量重加密。放在 create 而非 finalize，
 * 是为了让失败点集中在一次请求内，且客户端可立即知道该传哪些文件。
 */
async function reuseObjects(
  principal: SnapshotPrincipal,
  baseSnapshotId: string | undefined,
  files: SnapshotManifest['files'],
  newId: string,
  newDek: Buffer,
): Promise<SnapshotReuseResult> {
  const missing = files.map((file) => file.path);
  if (!baseSnapshotId) return { reused: [], missing };

  const base = await resolveUsableBase(baseSnapshotId, principal);
  if (!base) return { reused: [], missing };

  const baseDek = await loadDek(base);
  const baseFiles = new Map((await readManifest(base)).files.map((f) => [f.path, f]));
  const reused: string[] = [];
  for (const file of files) {
    const previous = baseFiles.get(file.path);
    if (!previous || previous.sha256 !== file.sha256) continue;
    try {
      const plain = decryptBlob(baseDek, await readFile(objectPath(baseSnapshotId, file.sha256)));
      if (createHash('sha256').update(plain).digest('hex') !== file.sha256) throw new Error('hash mismatch');
      const target = objectPath(newId, file.sha256);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, encryptBlob(newDek, plain));
      reused.push(file.path);
    } catch (e) {
      // 单个对象读不到/解不开时退回上传该文件，不让整个 create 失败。
      memoryLogger.warn(`reuse failed for ${file.path} from ${baseSnapshotId}: ${e}`, 'AgentSearch');
    }
  }
  const reusedSet = new Set(reused);
  return { reused, missing: files.map((f) => f.path).filter((p) => !reusedSet.has(p)) };
}

export async function getOwnedSnapshot(
  id: string,
  principal: SnapshotPrincipal,
): Promise<RepositorySnapshot> {
  const row = await repositorySnapshotDb.getById(id);
  if (!row || row.status === 'deleted') {
    throw new SnapshotError({ code: 'not_found', message: `snapshot ${id} not found` });
  }
  if (row.virtual_key_id !== principal.virtualKeyId) {
    // 不泄露存在性
    throw new SnapshotError({ code: 'not_found', message: `snapshot ${id} not found` });
  }
  return row;
}

async function loadDek(row: RepositorySnapshot): Promise<Buffer> {
  const masterKey = await getMasterKey();
  return unwrapDek(masterKey, row.dek_encrypted);
}

export async function readManifest(row: RepositorySnapshot): Promise<SnapshotManifest> {
  const dek = await loadDek(row);
  try {
    return JSON.parse(decryptText(dek, row.manifest_encrypted));
  } catch {
    throw new SnapshotError({
      code: 'invalid_manifest',
      message: `snapshot ${row.id} manifest is unreadable`,
    });
  }
}

export async function putObject(
  id: string,
  principal: SnapshotPrincipal,
  relPath: string,
  content: Buffer,
): Promise<void> {
  const row = await getOwnedSnapshot(id, principal);
  if (row.status !== 'uploading') {
    throw new SnapshotError({ code: 'invalid_state', message: `snapshot ${id} is ${row.status}` });
  }
  if (Date.now() > row.expires_at) {
    throw new SnapshotError({ code: 'expired', message: `snapshot ${id} expired` });
  }
  if (!isSafeSnapshotPath(relPath)) {
    throw new SnapshotError({ code: 'unknown_file', message: 'unsafe object path' });
  }
  const manifest = await readManifest(row);
  const entry = manifest.files.find((f) => f.path === relPath);
  if (!entry) {
    throw new SnapshotError({ code: 'unknown_file', message: `${relPath} is not in the snapshot manifest` });
  }
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== entry.sha256) {
    throw new SnapshotError({ code: 'hash_mismatch', message: `sha256 mismatch for ${relPath}` });
  }
  if (content.length !== entry.size) {
    throw new SnapshotError({
      code: 'hash_mismatch',
      message: `size mismatch for ${relPath}: expected ${entry.size}, got ${content.length}`,
    });
  }

  const dek = await loadDek(row);
  const enc = encryptBlob(dek, content);
  const target = objectPath(id, entry.sha256);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, enc);
}

export async function finalizeSnapshot(
  id: string,
  principal: SnapshotPrincipal,
): Promise<RepositorySnapshot> {
  const row = await getOwnedSnapshot(id, principal);
  if (row.status === 'ready') return row;
  if (row.status !== 'uploading') {
    throw new SnapshotError({ code: 'invalid_state', message: `snapshot ${id} is ${row.status}` });
  }

  const manifest = await readManifest(row);
  const missing: string[] = [];
  for (const file of manifest.files) {
    try {
      await stat(objectPath(id, file.sha256));
    } catch {
      missing.push(file.path);
    }
  }
  if (missing.length > 0) {
    throw new SnapshotError({
      code: 'incomplete',
      message: `${missing.length} manifest file(s) not uploaded: ${missing.slice(0, 5).join(', ')}`,
    });
  }

  await repositorySnapshotDb.markReady(id);
  memoryLogger.info(`Snapshot ${id} ready`, 'AgentSearch');
  return { ...row, status: 'ready' };
}

/**
 * 滑动 24h：run 真正消费快照时才续期，空闲快照照旧到期回收。
 * 只推进不缩短（`LEAST` 由 SQL 侧的 GREATEST 语义保证），避免并发续期把
 * 更晚的到期时间改小。
 */
export async function touchSnapshot(id: string): Promise<number | undefined> {
  const expiresAt = Date.now() + SNAPSHOT_RETENTION_MS;
  await repositorySnapshotDb.extendExpiry(id, expiresAt);
  return expiresAt;
}

/** 幂等删除：目录与 DB 状态都清掉。 */
export async function deleteSnapshot(id: string, principal: SnapshotPrincipal): Promise<void> {
  try {
    await getOwnedSnapshot(id, principal);
  } catch (e) {
    if (e instanceof SnapshotError && e.opError.code === 'not_found') return;
    throw e;
  }
  await rm(snapshotDir(id), { recursive: true, force: true });
  await repositorySnapshotDb.markDeleted(id);
  memoryLogger.info(`Snapshot ${id} deleted`, 'AgentSearch');
}

export async function buildWorkspace(snapshotId: string, destDir: string): Promise<void> {
  const row = await repositorySnapshotDb.getById(snapshotId);
  if (!row || row.status !== 'ready') {
    throw new SnapshotError({ code: 'invalid_state', message: `snapshot ${snapshotId} not ready` });
  }
  const dek = await loadDek(row);
  const manifest = await readManifest(row);

  await mkdir(destDir, { recursive: true });
  for (const file of manifest.files) {
    if (!isSafeSnapshotPath(file.path)) {
      throw new SnapshotError({ code: 'invalid_manifest', message: `unsafe path ${file.path}` });
    }
    const enc = await readFile(objectPath(snapshotId, file.sha256));
    const plain = decryptBlob(dek, enc);
    const hash = createHash('sha256').update(plain).digest('hex');
    if (hash !== file.sha256) {
      throw new SnapshotError({ code: 'hash_mismatch', message: `object hash mismatch: ${file.path}` });
    }
    const target = path.join(destDir, file.path);
    if (!target.startsWith(destDir + path.sep)) {
      throw new SnapshotError({ code: 'invalid_manifest', message: `path escapes workspace: ${file.path}` });
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, plain);
  }
}

/** 24h 保留期到期清理（cron 调用）。 */
export async function cleanupExpiredSnapshots(): Promise<number> {
  const expired = await repositorySnapshotDb.findExpired(Date.now());
  let cleaned = 0;
  for (const row of expired) {
    try {
      await rm(snapshotDir(row.id), { recursive: true, force: true });
      await repositorySnapshotDb.markDeleted(row.id);
      cleaned++;
    } catch (e) {
      memoryLogger.error?.(`Failed to clean snapshot ${row.id}: ${e}`, 'AgentSearch');
    }
  }
  return cleaned;
}
