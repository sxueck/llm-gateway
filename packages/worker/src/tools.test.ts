import { mkdtemp, rm, symlink, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Budget,
  ToolError,
  createToolContext,
  globFiles,
  grepSearch,
  listDirectory,
  readFileTool,
} from './tools.js';

let root: string;
let ctx: ReturnType<typeof createToolContext>;

const EXCLUDES = ['.env', '.env.*', '.git/**', 'node_modules/**', 'dist/**', 'build/**', '*.key'];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ws-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'function refresh() {\n  return 401;\n}\n');
  await writeFile(path.join(root, 'src', 'b.ts'), 'const code = 401;\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  await writeFile(path.join(root, 'server.key'), 'PRIVATE\n');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'x.js'), 'const code = 401;\n');
  await writeFile(path.join(root, '.git', 'config'), 'code = 401\n');
  ctx = createToolContext(root, EXCLUDES, new Budget(20, 6000), Date.now() + 30_000);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workspace containment', () => {
  it('grep finds sources but never excluded paths', async () => {
    const out = await grepSearch(ctx, { pattern: '401' });
    expect(out).toContain('src/a.ts:2');
    expect(out).toContain('src/b.ts:1');
    expect(out.includes('node_modules')).toBe(false);
    expect(out.includes('.git')).toBe(false);
  });

  it('grep scopes to a subdirectory and filters by glob', async () => {
    const out = await grepSearch(ctx, { pattern: '401', path: 'src', glob: 'a.ts' });
    expect(out).toContain('src/a.ts:2');
    expect(out).not.toContain('src/b.ts');
  });

  it('grep rejects invalid regex with a tool error', async () => {
    await expect(grepSearch(ctx, { pattern: '(' })).rejects.toBeInstanceOf(ToolError);
  });

  it('grep respects the file and line read budget', async () => {
    const tight = createToolContext(root, EXCLUDES, new Budget(1, 2), Date.now() + 30_000);

    const out = await grepSearch(tight, { pattern: '401' });

    expect(out).toContain('src/a.ts:2');
    expect(out).not.toContain('src/b.ts');
    expect(tight.budget.filesRead).toBe(1);
    expect(tight.budget.totalReadLines).toBe(2);
  });

  it('read_file returns numbered lines and honors offset/limit', async () => {
    const out = await readFileTool(ctx, { path: 'src/a.ts', offset: 2, limit: 1 });
    expect(out).toContain('2:   return 401;');
    expect(out).not.toContain('function refresh');
  });

  it('read_file rejects escapes, absolute paths and excluded files', async () => {
    await expect(readFileTool(ctx, { path: '../outside.ts' })).rejects.toBeInstanceOf(ToolError);
    await expect(readFileTool(ctx, { path: '/etc/passwd' })).rejects.toBeInstanceOf(ToolError);
    await expect(readFileTool(ctx, { path: '.env' })).rejects.toBeInstanceOf(ToolError);
    await expect(readFileTool(ctx, { path: 'server.key' })).rejects.toBeInstanceOf(ToolError);
  });

  it('read_file enforces the file/line budget', async () => {
    const tight = createToolContext(root, EXCLUDES, new Budget(1, 6000), Date.now() + 30_000);
    await readFileTool(tight, { path: 'src/a.ts' });
    await expect(readFileTool(tight, { path: 'src/b.ts' })).rejects.toThrow(/budget exhausted/);
  });

  it('read_file rejects symlink escapes', async () => {
    const outside = path.join(root, '..', 'outside-target.txt');
    await writeFile(outside, 'escaped\n');
    try {
      await symlink(outside, path.join(root, 'link.ts'));
      await expect(readFileTool(ctx, { path: 'link.ts' })).rejects.toBeInstanceOf(ToolError);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('list_directory hides excluded entries', async () => {
    const out = await listDirectory(ctx, {});
    expect(out).toContain('src/');
    expect(out).not.toContain('.env');
    expect(out).not.toContain('server.key');
  });

  it('glob_files matches across directories', async () => {
    const out = await globFiles(ctx, { pattern: 'src/*.ts' });
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(out).not.toContain('node_modules');
  });
});
