import { spawn } from 'child_process';
import { readdir, readFile, realpath, stat } from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { globToRegExp } from '@llm-gateway/shared';

const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_GREP_RESULTS = 200;
const MAX_MATCHES_PER_FILE = 5;
const MAX_GREP_CONTEXT_LINES = 3;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_GLOB_RESULTS = 500;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 500;

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class Budget {
  filesRead = 0;
  totalReadLines = 0;
  toolCalls = 0;
  constructor(
    public readonly maxFilesRead: number,
    public readonly maxTotalReadLines: number,
  ) {}
  exhausted(): boolean {
    return this.filesRead >= this.maxFilesRead || this.totalReadLines >= this.maxTotalReadLines;
  }
  tryReserveFileRead(): boolean {
    if (this.filesRead >= this.maxFilesRead) return false;
    this.filesRead += 1;
    return true;
  }
  tryNoteReadLines(lines: number): boolean {
    if (this.totalReadLines + lines > this.maxTotalReadLines) return false;
    this.totalReadLines += lines;
    return true;
  }
  tryNoteFileRead(lines: number): boolean {
    if (this.filesRead >= this.maxFilesRead || this.totalReadLines + lines > this.maxTotalReadLines) {
      return false;
    }
    this.filesRead += 1;
    this.totalReadLines += lines;
    return true;
  }
}

export interface ToolContext {
  root: string;
  excludeGlobs: string[];
  excludeMatchers: RegExp[];
  budget: Budget;
  deadline: number;
}

export function createToolContext(root: string, excludeGlobs: string[], budget: Budget, deadline: number): ToolContext {
  return {
    root,
    excludeGlobs,
    excludeMatchers: excludeGlobs.map((g) => globToRegExp(g)),
    budget,
    deadline,
  };
}

/** root containment + 排除规则；返回相对 root 的 POSIX 路径，非法返回 null。 */
async function resolveWithinRoot(ctx: ToolContext, relPath: string): Promise<string | null> {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  if (relPath.includes('\0')) return null;
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) return null;
  const normalized = path.normalize(relPath);
  if (normalized.split(path.sep).some((seg) => seg === '..')) return null;

  const abs = path.resolve(ctx.root, normalized);
  if (abs !== ctx.root && !abs.startsWith(ctx.root + path.sep)) return null;

  // symlink 逃逸检查
  let realAbs: string;
  let realRoot: string;
  try {
    realAbs = await realpath(abs);
    realRoot = await realpath(ctx.root);
  } catch {
    return null;
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) return null;

  const rel = path.relative(ctx.root, abs).split(path.sep).join('/');
  if (isExcluded(ctx, rel)) return null;
  return rel;
}

function isExcluded(ctx: ToolContext, relPath: string): boolean {
  const segments = relPath.split('/');
  const suffixes: string[] = [];
  for (let i = 0; i < segments.length; i++) suffixes.push(segments.slice(i).join('/'));
  return ctx.excludeMatchers.some((re) => suffixes.some((s) => re.test(s)));
}

interface WalkedFile {
  rel: string;
  abs: string;
  size: number;
}

async function walkFiles(ctx: ToolContext, dirRel: string, out: WalkedFile[], cap: number): Promise<void> {
  if (out.length >= cap || Date.now() > ctx.deadline) return;
  const absDir = dirRel ? path.join(ctx.root, dirRel) : ctx.root;
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
    if (isExcluded(ctx, rel)) continue;
    if (entry.isDirectory()) {
      await walkFiles(ctx, rel, out, cap);
    } else if (entry.isFile()) {
      try {
        const info = await stat(path.join(ctx.root, rel));
        out.push({ rel, abs: path.join(ctx.root, rel), size: info.size });
      } catch {
        // 竞态删除等，跳过
      }
    }
  }
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…[output truncated at ${MAX_TOOL_OUTPUT_CHARS} chars]`,
    truncated: true,
  };
}

function assertParams(obj: Record<string, unknown>, keys: { name: string; type: 'string' | 'number'; required?: boolean; min?: number; max?: number }[]): Record<string, unknown> {
  for (const key of keys) {
    const value = obj[key.name];
    if (value === undefined || value === null) {
      if (key.required) throw new ToolError(`missing required parameter "${key.name}"`);
      continue;
    }
    if (key.type === 'string' && typeof value !== 'string') {
      throw new ToolError(`parameter "${key.name}" must be a string`);
    }
    if (key.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ToolError(`parameter "${key.name}" must be a number`);
      if (key.min !== undefined && n < key.min) throw new ToolError(`parameter "${key.name}" must be >= ${key.min}`);
      if (key.max !== undefined && n > key.max) throw new ToolError(`parameter "${key.name}" must be <= ${key.max}`);
    }
  }
  return obj;
}

// ============ grep_search ============

const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;

interface RgResult {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
}

/** 通过参数数组调用 rg，无 shell；stdout 有上限、进程受 ctx.deadline 约束。 */
function spawnRg(args: string[], cwd: string, timeoutMs: number): Promise<RgResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_RG_STDOUT_BYTES && !aborted) {
        aborted = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code, aborted });
    });
  });
}

export async function grepSearch(ctx: ToolContext, params: Record<string, unknown>): Promise<string> {
  assertParams(params, [
    { name: 'pattern', type: 'string', required: true },
    { name: 'path', type: 'string' },
    { name: 'glob', type: 'string' },
    { name: 'context_lines', type: 'number', min: 0, max: MAX_GREP_CONTEXT_LINES },
  ]);
  const pattern = String(params.pattern);
  try {
    new RegExp(pattern); // 保留原有 JS 正则校验语义
  } catch (e) {
    throw new ToolError(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
  const scopeRel = params.path ? await resolveWithinRoot(ctx, String(params.path)) : '.';
  if (scopeRel === null) throw new ToolError(`path "${params.path}" is outside the workspace or excluded`);
  if (ctx.budget.exhausted()) return '0 match(es)\n';

  // glob：用户 glob 在前，策略排除 glob 在后 —— rg 中后匹配的 glob 优先，
  // 因此策略排除始终压过用户 glob，无法重新包含被排除路径。
  const args: string[] = [
    '--line-number',
    '--no-heading',
    '--color', 'never',
    '--no-ignore',
    '--max-filesize', `${Math.floor(MAX_GREP_FILE_BYTES / (1024 * 1024))}M`,
  ];
  if (params.glob) args.push('-g', String(params.glob));
  const contextLines = params.context_lines === undefined ? 0 : Math.floor(Number(params.context_lines));
  if (contextLines > 0) args.push('-C', String(contextLines));
  for (const g of ctx.excludeGlobs) {
    args.push('-g', `!${g}`);
    if (g.includes('/') && !g.startsWith('**/')) args.push('-g', `!**/${g}`); // 任意深度排除，对齐旧后缀匹配语义
  }
  args.push('-e', pattern);
  args.push('--', scopeRel);

  let res: RgResult;
  try {
    res = await spawnRg(args, ctx.root, Math.max(0, ctx.deadline - Date.now()));
  } catch (e) {
    throw new ToolError(`grep_search failed: ripgrep unavailable (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res.code === 2 && !res.aborted) {
    throw new ToolError(`invalid regex or search error: ${res.stderr.trim().split('\n')[0] || 'ripgrep exited with 2'}`);
  }

  // 解析 rg 输出：匹配行 `rel:LINE:text`、上下文行 `rel-LINE-text`、`--` 块分隔。
  // 每文件最多保留 MAX_MATCHES_PER_FILE 个匹配（含其上下文行），其余以计数尾注带出，
  // 防止单文件热点灌满结果窗口；尾注行同样计入行预算。预算按文件分组原子预留
  // （同步 ⇒ 并发下不会超额）。
  const perFile: { rel: string; entries: { text: string; isMatch: boolean }[]; matchTotal: number }[] = [];
  let total = 0;
  for (const raw of res.stdout.split('\n')) {
    if (!raw || total >= MAX_GREP_RESULTS) break;
    const m = raw.match(/^(.+?)([:\-])(\d+)([:\-])(.*)$/);
    if (!m) continue;
    const rel = m[1];
    const isMatch = m[2] === ':' && m[4] === ':';
    if (!isMatch && !(m[2] === '-' && m[4] === '-')) continue;
    if (isMatch) total++;
    const text = `${rel}${m[2]}${m[3]}${m[4]} ${m[5].slice(0, 300)}`;
    const last = perFile[perFile.length - 1];
    if (last && last.rel === rel) {
      last.entries.push({ text, isMatch });
      if (isMatch) last.matchTotal++;
    } else {
      perFile.push({ rel, entries: [{ text, isMatch }], matchTotal: isMatch ? 1 : 0 });
    }
  }

  const hits: string[] = [];
  let returnedMatches = 0;
  let fileCapped = false;
  for (const group of perFile) {
    if (ctx.budget.exhausted()) break;
    const kept: string[] = [];
    let keptMatches = 0;
    for (const entry of group.entries) {
      if (entry.isMatch && keptMatches >= MAX_MATCHES_PER_FILE) break;
      if (entry.isMatch) keptMatches++;
      kept.push(entry.text);
    }
    if (group.matchTotal > keptMatches) {
      fileCapped = true;
      kept.push(`… ${group.matchTotal - keptMatches} more match(es) in ${group.rel}`);
    }
    if (!ctx.budget.tryNoteFileRead(kept.length)) break; // 原子预留；失败即到此为止
    hits.push(...kept);
    returnedMatches += keptMatches;
  }

  const capped = total >= MAX_GREP_RESULTS || res.aborted || fileCapped;
  const header = `${returnedMatches} match(es)${capped ? ' (capped)' : ''}\n`;
  return truncateOutput(header + hits.join('\n')).text;
}

// ============ read_file ============

export async function readFileTool(ctx: ToolContext, params: Record<string, unknown>): Promise<string> {
  assertParams(params, [
    { name: 'path', type: 'string', required: true },
    { name: 'offset', type: 'number', min: 1 },
    { name: 'limit', type: 'number', min: 1, max: MAX_READ_LINES },
  ]);
  const rel = await resolveWithinRoot(ctx, String(params.path));
  if (rel === null) throw new ToolError(`path "${params.path}" is outside the workspace or excluded`);
  if (!ctx.budget.tryReserveFileRead()) {
    throw new ToolError(`read budget exhausted (max ${ctx.budget.maxFilesRead} files / ${ctx.budget.maxTotalReadLines} lines)`);
  }

  let content: string;
  try {
    content = await readFile(path.join(ctx.root, rel), 'utf8');
  } catch (e) {
    throw new ToolError(`cannot read "${rel}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const lines = content.split('\n');
  const offset = params.offset ? Math.floor(Number(params.offset)) : 1;
  const limit = params.limit ? Math.floor(Number(params.limit)) : DEFAULT_READ_LINES;
  const remainingLines = ctx.budget.maxTotalReadLines - ctx.budget.totalReadLines;
  if (remainingLines <= 0) {
    throw new ToolError(`read budget exhausted (max ${ctx.budget.maxFilesRead} files / ${ctx.budget.maxTotalReadLines} lines)`);
  }
  const slice = lines.slice(offset - 1, offset - 1 + Math.min(limit, remainingLines));
  if (!ctx.budget.tryNoteReadLines(slice.length)) {
    throw new ToolError(`read budget exhausted (max ${ctx.budget.maxFilesRead} files / ${ctx.budget.maxTotalReadLines} lines)`);
  }

  const numbered = slice.map((line, i) => `${offset + i}: ${line.slice(0, 400)}`).join('\n');
  const header = `${rel} lines ${offset}-${offset + slice.length - 1} of ${lines.length}\n`;
  return truncateOutput(header + numbered).text;
}

// ============ list_directory ============

export async function listDirectory(ctx: ToolContext, params: Record<string, unknown>): Promise<string> {
  assertParams(params, [{ name: 'path', type: 'string' }]);
  const rel = params.path ? await resolveWithinRoot(ctx, String(params.path)) : '.';
  if (rel === null) throw new ToolError(`path "${params.path}" is outside the workspace or excluded`);

  const absDir = rel === '.' ? ctx.root : path.join(ctx.root, rel);
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (e) {
    throw new ToolError(`cannot list "${rel}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const lines = entries
    .filter((e) => !isExcluded(ctx, rel === '.' ? e.name : `${rel}/${e.name}`))
    .slice(0, MAX_LIST_ENTRIES)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  const header = `${rel === '.' ? '.' : rel} (${lines.length} entries${entries.length > MAX_LIST_ENTRIES ? ', capped' : ''})\n`;
  return truncateOutput(header + lines.join('\n')).text;
}

// ============ glob_files ============

export async function globFiles(ctx: ToolContext, params: Record<string, unknown>): Promise<string> {
  assertParams(params, [{ name: 'pattern', type: 'string', required: true }]);
  const re = globToRegExp(String(params.pattern));
  const files: WalkedFile[] = [];
  await walkFiles(ctx, '', files, 20_000);
  const matches = files
    .filter((f) => re.test(f.rel) || re.test(f.rel.split('/').pop()!))
    .slice(0, MAX_GLOB_RESULTS)
    .map((f) => f.rel);
  const header = `${matches.length} match(es)${matches.length >= MAX_GLOB_RESULTS ? ' (capped)' : ''}\n`;
  return truncateOutput(header + matches.join('\n')).text;
}

export const TOOL_IMPLEMENTATIONS: Record<string, (ctx: ToolContext, params: Record<string, unknown>) => Promise<string>> = {
  grep_search: grepSearch,
  read_file: readFileTool,
  list_directory: listDirectory,
  glob_files: globFiles,
};

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search file contents with a regular expression. Returns `path:line: text` matches across the workspace (respecting exclude rules).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression' },
          path: { type: 'string', description: 'Optional directory scope (workspace-relative)' },
          glob: { type: 'string', description: 'Optional file glob filter, e.g. "*.ts"' },
          context_lines: {
            type: 'integer',
            description: 'Lines of context around each match (0-3, default 0). Context lines are prefixed with the file path and a dash separator.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a workspace file with line numbers. Offset and limit control the line window.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
          offset: { type: 'integer', description: '1-based start line' },
          limit: { type: 'integer', description: 'Max lines to return (default 200, max 500)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List direct entries of a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory (default ".")' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description: 'List workspace files matching a glob pattern (supports *, ?, **).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "packages/*/src/**/*.ts"' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
] as const;
