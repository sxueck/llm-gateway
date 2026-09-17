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

  it('grep treats a scope starting with a dash as a literal path', async () => {
    await mkdir(path.join(root, '--glob=*.env'));

    const out = await grepSearch(ctx, { pattern: 'SECRET', path: '--glob=*.env' });

    expect(out).toContain('0 match(es)');
    expect(out).not.toContain('.env');
  });

  it('grep rejects invalid regex with a tool error', async () => {
    await expect(grepSearch(ctx, { pattern: '(' })).rejects.toBeInstanceOf(ToolError);
  });

  it('grep scans non-matches without consuming the result read budget', async () => {
    await mkdir(path.join(root, 'docs'));
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        writeFile(path.join(root, 'docs', `${i}.md`), 'unrelated content\n'),
      ),
    );
    await writeFile(path.join(root, 'src', 'target.ts'), 'const TARGET = true;\n');
    const tight = createToolContext(root, EXCLUDES, new Budget(1, 2), Date.now() + 30_000);

    const missed = await grepSearch(tight, { pattern: 'TARGET', path: 'docs' });
    const found = await grepSearch(tight, { pattern: 'TARGET', path: 'src' });

    expect(missed).toContain('0 match(es)');
    expect(found).toContain('src/target.ts:1');
    expect(tight.budget.filesRead).toBe(1);
    expect(tight.budget.totalReadLines).toBe(1);
  });

  it('grep limits returned matches by the file and line read budget', async () => {
    const tight = createToolContext(root, EXCLUDES, new Budget(1, 2), Date.now() + 30_000);

    const out = await grepSearch(tight, { pattern: '401' });

    expect(out).toMatch(/src\/[ab]\.ts:\d+:/);
    expect(out.match(/:\d+:/g)).toHaveLength(1);
    expect(tight.budget.filesRead).toBe(1);
    expect(tight.budget.totalReadLines).toBe(1);
  });

  it('grep honors the user glob but never re-includes excluded paths', async () => {
    // 用户 glob 只能看到未被排除的文件
    const out = await grepSearch(ctx, { pattern: '401', glob: '**/*.ts' });
    expect(out).toContain('src/a.ts:2');
    expect(out.includes('node_modules')).toBe(false);
    expect(out.includes('.git')).toBe(false);
    // 排除目录整体作为 scope 时：路径仍被拒/无匹配，绝不泄漏内容
    const excludedScope = await grepSearch(ctx, { pattern: '401', path: 'node_modules' });
    expect(excludedScope).toContain('0 match(es)');
  });

  it('grep reserves read budget atomically across concurrent calls', async () => {
    const tight = createToolContext(root, EXCLUDES, new Budget(1, 1), Date.now() + 30_000);
    const [a, b] = await Promise.all([
      grepSearch(tight, { pattern: '401' }),
      grepSearch(tight, { pattern: '401' }),
    ]);
    const totalHits = (a.match(/:\d+:/g) ?? []).length + (b.match(/:\d+:/g) ?? []).length;
    expect(totalHits).toBe(1);
    expect(tight.budget.totalReadLines).toBe(1);
    expect(tight.budget.filesRead).toBe(1);
  });

  it('grep caps matches per file and notes the remainder', async () => {
    await writeFile(
      path.join(root, 'src', 'many.ts'),
      `${Array.from({ length: 8 }, (_, i) => `const v${i} = 401;`).join('\n')}\n`,
    );

    const out = await grepSearch(ctx, { pattern: '401', path: 'src', glob: 'many.ts' });

    expect(out.match(/many\.ts:\d+:/g)).toHaveLength(5);
    expect(out).toContain('3 more match(es) in src/many.ts');
    expect(out).toContain('(capped)');
    expect(ctx.budget.filesRead).toBe(1);
    // 5 条匹配 + 1 条尾注都进入结果，同样计入行预算
    expect(ctx.budget.totalReadLines).toBe(6);
  });

  it('grep returns context lines that consume the line budget', async () => {
    const tight = createToolContext(root, EXCLUDES, new Budget(1, 10), Date.now() + 30_000);

    const out = await grepSearch(tight, { pattern: '401', glob: 'a.ts', context_lines: 1 });

    expect(out).toContain('src/a.ts-1-');
    expect(out).toContain('src/a.ts:2:');
    expect(out).toContain('src/a.ts-3-');
    expect(tight.budget.filesRead).toBe(1);
    expect(tight.budget.totalReadLines).toBe(3);
  });

  it('grep rejects context_lines above the maximum', async () => {
    await expect(grepSearch(ctx, { pattern: '401', context_lines: 4 })).rejects.toBeInstanceOf(ToolError);
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

  it('read_file reserves the file budget atomically across concurrent calls', async () => {
    const tight = createToolContext(root, EXCLUDES, new Budget(1, 6000), Date.now() + 30_000);
    const results = await Promise.allSettled([
      readFileTool(tight, { path: 'src/a.ts' }),
      readFileTool(tight, { path: 'src/b.ts' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(tight.budget.filesRead).toBe(1);
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
