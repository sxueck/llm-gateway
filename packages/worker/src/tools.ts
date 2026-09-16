import { readdir, readFile, realpath, stat } from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { globToRegExp } from '@llm-gateway/shared';

const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_GREP_RESULTS = 200;
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
  noteFileRead(lines: number): void {
    this.filesRead += 1;
    this.totalReadLines += lines;
  }
}

export interface ToolContext {
  root: string;
  excludeMatchers: RegExp[];
  budget: Budget;
  deadline: number;
}

export function createToolContext(root: string, excludeGlobs: string[], budget: Budget, deadline: number): ToolContext {
  return {
    root,
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

export async function grepSearch(ctx: ToolContext, params: Record<string, unknown>): Promise<string> {
  assertParams(params, [
    { name: 'pattern', type: 'string', required: true },
    { name: 'path', type: 'string' },
    { name: 'glob', type: 'string' },
  ]);
  let regex: RegExp;
  try {
    regex = new RegExp(String(params.pattern));
  } catch (e) {
    throw new ToolError(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
  const scopeRel = params.path ? await resolveWithinRoot(ctx, String(params.path)) : '';
  if (params.path && scopeRel === null) throw new ToolError(`path "${params.path}" is outside the workspace or excluded`);
  const glob = params.glob ? String(params.glob) : null;
  const globRe = glob ? globToRegExp(glob) : null;

  const files: WalkedFile[] = [];
  await walkFiles(ctx, scopeRel ?? '', files, 5000);

  const hits: string[] = [];
  let scanned = 0;
  for (const file of files) {
    if (
      hits.length >= MAX_GREP_RESULTS ||
      Date.now() > ctx.deadline ||
      ctx.budget.exhausted()
    )
      break;
    if (globRe && !globRe.test(file.rel) && !globRe.test(file.rel.split('/').pop()!)) continue;
    if (file.size > MAX_GREP_FILE_BYTES || file.size === 0) continue;
    let content: Buffer;
    try {
      content = await readFile(file.abs);
    } catch {
      continue;
    }
    if (content.includes(0)) {
      ctx.budget.noteFileRead(0);
      continue;
    }
    const remainingLines =
      ctx.budget.maxTotalReadLines - ctx.budget.totalReadLines;
    const lines = content.toString('utf8').split('\n').slice(0, remainingLines);
    ctx.budget.noteFileRead(lines.length);
    scanned++;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        hits.push(`${file.rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
        if (hits.length >= MAX_GREP_RESULTS) break;
      }
    }
  }
  const header = `${hits.length} match(es)${scanned ? ` in ${scanned} file(s)` : ''}${hits.length >= MAX_GREP_RESULTS ? ' (capped)' : ''}\n`;
  return truncateOutput(header + hits.join('\n')).text;
}

// ============ read_file ============

export async function readFileTool(ctx: ToolContext, params: Record<string, unknown>): Promise<string> {
  assertParams(params, [
    { name: 'path', type: 'string', required: true },
    { name: 'offset', type: 'number', min: 1 },
    { name: 'limit', type: 'number', min: 1, max: MAX_READ_LINES },
  ]);
  if (ctx.budget.exhausted()) {
    throw new ToolError(`read budget exhausted (max ${ctx.budget.maxFilesRead} files / ${ctx.budget.maxTotalReadLines} lines)`);
  }
  const rel = await resolveWithinRoot(ctx, String(params.path));
  if (rel === null) throw new ToolError(`path "${params.path}" is outside the workspace or excluded`);

  let content: string;
  try {
    content = await readFile(path.join(ctx.root, rel), 'utf8');
  } catch (e) {
    throw new ToolError(`cannot read "${rel}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const lines = content.split('\n');
  const offset = params.offset ? Math.floor(Number(params.offset)) : 1;
  const limit = params.limit ? Math.floor(Number(params.limit)) : DEFAULT_READ_LINES;
  const slice = lines.slice(offset - 1, offset - 1 + limit);

  ctx.budget.noteFileRead(slice.length);

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
