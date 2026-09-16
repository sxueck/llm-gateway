import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = new Map<string, any>();
  return {
    rows,
    repositorySnapshotRepository: {
      create: vi.fn(async (row: any) => {
        rows.set(row.id, { ...row, deleted_at: null });
        return rows.get(row.id);
      }),
      getById: vi.fn(async (id: string) => rows.get(id)),
      markReady: vi.fn(async (id: string) => {
        rows.get(id).status = 'ready';
      }),
      markDeleted: vi.fn(async (id: string) => {
        const row = rows.get(id);
        row.status = 'deleted';
        row.deleted_at = Date.now();
      }),
      findExpired: vi.fn(async () => []),
    },
    systemConfigRepository: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    },
  };
});

vi.mock('../../db/index.js', () => ({
  repositorySnapshotDb: mocks.repositorySnapshotRepository,
  systemConfigDb: mocks.systemConfigRepository,
}));
vi.mock('../../services/logger.js', () => ({
  memoryLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildWorkspace,
  createSnapshot,
  deleteSnapshot,
  finalizeSnapshot,
  putObject,
  SnapshotError,
} from './snapshot.service.js';
import { getMasterKey } from './encryption.js';

let storageDir: string;

function file(path_: string, content: string) {
  const buf = Buffer.from(content, 'utf8');
  return { path: path_, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, language: 'ts' };
}

function contentFor(entry: { path: string; content?: string }) {
  return Buffer.from(entry.content ?? `// content of ${entry.path}\n`, 'utf8');
}

async function makeSnapshot(paths: string[]) {
  const files = paths.map((p) => file(p, `// content of ${p}\n`));
  const row = await createSnapshot({ virtualKeyId: 'vk-1' }, {
    source: 'pi_local_worktree',
    repository: { display_name: 'demo' },
    manifest: { format_version: 1, files, excluded: [] },
  });
  return { row, files };
}

beforeEach(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'agent-snap-'));
  process.env.AGENT_SNAPSHOT_STORAGE_DIR = storageDir;
  process.env.AGENT_SNAPSHOT_MASTER_KEY = 'a'.repeat(64);
  await getMasterKey();
});

afterEach(async () => {
  delete process.env.AGENT_SNAPSHOT_STORAGE_DIR;
  delete process.env.AGENT_SNAPSHOT_MASTER_KEY;
  await rm(storageDir, { recursive: true, force: true });
});

describe('snapshot lifecycle', () => {
  it('rejects manifests containing platform-forbidden paths', async () => {
    await expect(makeSnapshot(['.env'])).rejects.toMatchObject({
      opError: { code: 'invalid_manifest' },
    });
    await expect(makeSnapshot(['id_rsa'])).rejects.toBeInstanceOf(SnapshotError);
    await expect(makeSnapshot(['nested/node_modules/pkg/index.js'])).rejects.toBeInstanceOf(SnapshotError);
  });

  it('rejects unsafe manifest paths', async () => {
    await expect(makeSnapshot(['../escape.txt'])).rejects.toMatchObject({
      opError: { code: 'invalid_manifest' },
    });
  });

  it('round-trips objects through encrypted storage and verifies hash', async () => {
    const { row, files } = await makeSnapshot(['src/a.ts', 'src/b.ts']);
    expect(row.status).toBe('uploading');

    const a = contentFor({ path: 'src/a.ts' });
    await putObject(row.id, { virtualKeyId: 'vk-1' }, 'src/a.ts', a);

    // 未在 manifest 中的文件被拒
    await expect(putObject(row.id, { virtualKeyId: 'vk-1' }, 'src/c.ts', a)).rejects.toMatchObject({
      opError: { code: 'unknown_file' },
    });
    // 内容 hash 不匹配被拒
    await expect(
      putObject(row.id, { virtualKeyId: 'vk-1' }, 'src/b.ts', Buffer.from('tampered')),
    ).rejects.toMatchObject({ opError: { code: 'hash_mismatch' } });

    // 其他 key 的属主不能访问
    await expect(
      putObject(row.id, { virtualKeyId: 'vk-2' }, 'src/a.ts', a),
    ).rejects.toMatchObject({ opError: { code: 'not_found' } });

    // 少一个文件时 finalize 报 incomplete
    await expect(finalizeSnapshot(row.id, { virtualKeyId: 'vk-1' })).rejects.toMatchObject({
      opError: { code: 'incomplete' },
    });

    await putObject(row.id, { virtualKeyId: 'vk-1' }, 'src/b.ts', contentFor({ path: 'src/b.ts' }));
    const finalized = await finalizeSnapshot(row.id, { virtualKeyId: 'vk-1' });
    expect(finalized.status).toBe('ready');

    // 落盘内容必须已加密（不含明文）
    const objectsDir = path.join(storageDir, row.id, 'objects');
    const stored = await readFile(path.join(objectsDir, `${files[0].sha256}.enc`));
    expect(stored.includes(Buffer.from('// content of src/a.ts'))).toBe(false);

    // workspace 重建后明文一致
    const ws = path.join(storageDir, 'ws');
    await buildWorkspace(row.id, ws);
    expect((await readFile(path.join(ws, 'src/a.ts'))).toString()).toContain('content of src/a.ts');
    expect((await readFile(path.join(ws, 'src/b.ts'))).toString()).toContain('content of src/b.ts');
  });

  it('buildWorkspace fails when an encrypted object is tampered', async () => {
    const { row } = await makeSnapshot(['src/a.ts']);
    await putObject(row.id, { virtualKeyId: 'vk-1' }, 'src/a.ts', contentFor({ path: 'src/a.ts' }));
    await finalizeSnapshot(row.id, { virtualKeyId: 'vk-1' });

    const objectsDir = path.join(storageDir, row.id, 'objects');
    const [name] = await readdir(objectsDir);
    const buf = await readFile(path.join(objectsDir, name));
    buf[buf.length - 1] = 0xff;
    const { writeFile } = await import('fs/promises');
    await writeFile(path.join(objectsDir, name), buf);

    await expect(buildWorkspace(row.id, path.join(storageDir, 'ws2'))).rejects.toBeInstanceOf(Error);
  });

  it('deleteSnapshot is idempotent and removes storage', async () => {
    const { row } = await makeSnapshot(['src/a.ts']);
    await deleteSnapshot(row.id, { virtualKeyId: 'vk-1' });
    await expect(deleteSnapshot(row.id, { virtualKeyId: 'vk-1' })).resolves.toBeUndefined();
    await expect(
      putObject(row.id, { virtualKeyId: 'vk-1' }, 'src/a.ts', contentFor({ path: 'src/a.ts' })),
    ).rejects.toMatchObject({ opError: { code: 'not_found' } });
  });
});
