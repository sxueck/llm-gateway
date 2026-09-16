// Agent Search / Worker Plugin Center 共享类型（Phase 1 垂直最小链路）

import { z } from "zod";

// ============ Worker Plugin Manifest ============

/** Phase 1 平台预置的 worker 工具；插件 allow 必须是其子集。 */
export const WORKER_TOOL_IDS = [
  "grep_search",
  "read_file",
  "list_directory",
  "glob_files",
] as const;
export type WorkerToolId = (typeof WORKER_TOOL_IDS)[number];

export const pluginToolPolicySchema = z.object({
  allow: z.array(z.string().min(1)).min(1),
  deny: z.array(z.string().min(1)).default([]),
  max_parallel_calls: z.number().int().min(1).max(16).default(6),
});

export const pluginWorkspacePolicySchema = z.object({
  mode: z.literal("read_only"),
  allowed_roots: z.array(z.string().startsWith("/")).min(1),
  exclude_globs: z.array(z.string().min(1)).default([]),
});

export const pluginExecutionPolicySchema = z.object({
  max_turns: z.number().int().min(1).max(20),
  timeout_seconds: z.number().int().min(10).max(600),
  max_files_read: z.number().int().min(1).max(200),
  max_total_read_lines: z.number().int().min(100).max(100_000),
  max_result_tokens: z.number().int().min(256).max(32_000),
});

export const pluginModelPolicySchema = z.object({
  profile: z.string().min(1),
  allow_client_override: z.boolean().default(false),
});

export const workerPluginManifestSchema = z.object({
  schema_version: z.literal("1"),
  id: z
    .string()
    .regex(
      /^com\.llm-gateway\.[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "plugin id must be a reverse-domain name under com.llm-gateway",
    ),
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver x.y.z"),
  description: z.string().max(500).optional(),
  runtime: z.object({
    kind: z.literal("pi-worker"),
    min_pi_version: z.string().optional(),
  }),
  role: z.object({
    system_prompt: z.string(),
    input_schema: z.string(),
    output_schema: z.string(),
  }),
  tool_policy: pluginToolPolicySchema,
  workspace_policy: pluginWorkspacePolicySchema,
  execution_policy: pluginExecutionPolicySchema,
  model_policy: pluginModelPolicySchema,
});

export type WorkerPluginManifest = z.infer<typeof workerPluginManifestSchema>;

// Bundle 内允许被 role.* 引用的文件名（Phase 1 固定集合）
export const PLUGIN_BUNDLE_FILES = [
  "prompt.md",
  "input.schema.json",
  "output.schema.json",
] as const;

/**
 * bundle 文件引用必须是相对的、不含路径穿越的已知文件名。
 */
export function isSafeBundleFileRef(ref: string): boolean {
  if (!ref.startsWith("./")) return false;
  const name = ref.slice(2);
  if (name.includes("/") || name.includes("\\") || name.includes(".."))
    return false;
  return (PLUGIN_BUNDLE_FILES as readonly string[]).includes(name);
}

// ============ Repository Snapshot ============

/** 平台强制排除规则：即使客户端 manifest 包含这些路径，服务端也拒绝接收。 */
export const SNAPSHOT_FORBIDDEN_PATH_GLOBS: readonly string[] = [
  ".env",
  ".env.*",
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  "*.pem",
  "*.key",
  "*.p12",
  "*.crt",
  "id_rsa",
  "id_rsa.*",
  "credentials*",
  "auth.json",
];

export const SNAPSHOT_MAX_FILES = 20_000;
export const SNAPSHOT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const SNAPSHOT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export const snapshotFileEntrySchema = z.object({
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(1).max(SNAPSHOT_MAX_FILE_BYTES),
  language: z.string().max(50).optional(),
});

export const snapshotExcludedEntrySchema = z.object({
  path: z.string().min(1).max(1024),
  reason: z.string().min(1).max(200),
});

export const snapshotManifestSchema = z.object({
  format_version: z.literal(1),
  files: z.array(snapshotFileEntrySchema).min(1).max(SNAPSHOT_MAX_FILES),
  excluded: z.array(snapshotExcludedEntrySchema).default([]),
});

export type SnapshotFileEntry = z.infer<typeof snapshotFileEntrySchema>;
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export const createSnapshotRequestSchema = z.object({
  source: z.literal("pi_local_worktree"),
  repository: z.object({
    display_name: z.string().min(1).max(200),
    git_remote: z.string().url().max(2000).optional(),
    head_commit: z
      .string()
      .regex(/^[0-9a-f]{6,40}$/)
      .optional(),
  }),
  manifest: snapshotManifestSchema,
});

export type CreateSnapshotRequest = z.infer<typeof createSnapshotRequestSchema>;

export const SNAPSHOT_STATUSES = ["uploading", "ready", "deleted"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

/**
 * 快照内相对路径安全校验：POSIX 相对路径、无 `..`、无绝对路径、无反斜杠、非空段。
 */
export function isSafeSnapshotPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** 将 `**`/`*`/`?` glob 转为完整匹配的 RegExp。 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `/**/` 匹配零个或多个目录段；`**` 匹配任意
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

/** 判断快照路径是否命中平台强制排除规则（对任意深度的段后缀与 basename 都匹配）。 */
export function isForbiddenSnapshotPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1] ?? normalized;
  // 逐段后缀：使 `node_modules/**` 也命中 `a/b/node_modules/x`
  const suffixes: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    suffixes.push(segments.slice(i).join("/"));
  }
  return SNAPSHOT_FORBIDDEN_PATH_GLOBS.some((glob) => {
    const re = globToRegExp(glob);
    return suffixes.some((s) => re.test(s)) || re.test(basename);
  });
}

// ============ Agent Search Run ============

export const SEARCH_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
  "expired",
] as const;
export type SearchRunStatus = (typeof SEARCH_RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly SearchRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
  "expired",
];

export const createSearchRunRequestSchema = z.object({
  plugin: z.object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("snapshot"),
      snapshot_id: z.string().min(1),
    }),
  ]),
  query: z.string().min(1).max(8000),
  options: z
    .object({
      model_profile: z.string().min(1).max(128).optional(),
    })
    .default({}),
});

export type CreateSearchRunRequest = z.infer<
  typeof createSearchRunRequestSchema
>;

export const SEARCH_RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "source.resolved",
  "worker.started",
  "tool.started",
  "tool.completed",
  "model.completed",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;
export type SearchRunEventType = (typeof SEARCH_RUN_EVENT_TYPES)[number];

export const TERMINAL_RUN_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export interface SearchRunEvent {
  run_id: string;
  seq: number;
  type: SearchRunEventType;
  payload: Record<string, unknown>;
  created_at: number;
}

// ============ 结构化结果 ============

export const structuredResultFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
    reason: z.string().min(1).max(2000),
    evidence: z.string().max(4000).optional(),
  })
  .refine((v) => v.end_line >= v.start_line, {
    message: "end_line must be >= start_line",
    path: ["end_line"],
  });

export const structuredResultUsageSchema = z.object({
  plugin: z.string(),
  model_profile: z.string(),
  turns: z.number().int().min(0),
  tool_calls: z.number().int().min(0),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cost: z.number().min(0),
});

export const structuredResultSchema = z.object({
  run_id: z.string(),
  status: z.literal("completed"),
  repository: z.object({
    source_type: z.enum(["snapshot", "public_git"]),
    snapshot_id: z.string().nullable().optional(),
    commit: z.string().nullable().optional(),
  }),
  summary: z.string().min(1).max(4000),
  files: z.array(structuredResultFileSchema).max(50),
  uncertainties: z.array(z.string().max(1000)).max(20).default([]),
  next_questions: z.array(z.string().max(1000)).max(20).default([]),
  usage: structuredResultUsageSchema,
});

export type StructuredResultFile = z.infer<typeof structuredResultFileSchema>;
export type StructuredSearchResult = z.infer<typeof structuredResultSchema>;

// ============ Internal completion（gateway ↔ worker） ============

export const internalCompletionRequestSchema = z.object({
  run_id: z.string().min(1),
  model_profile: z.string().min(1),
  turn: z.number().int().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string().nullable(),
      tool_calls: z
        .array(
          z.object({
            id: z.string(),
            type: z.literal("function"),
            function: z.object({
              name: z.string(),
              arguments: z.string(),
            }),
          }),
        )
        .optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  max_tokens: z.number().int().min(1).max(32_000).optional(),
});

export type InternalCompletionRequest = z.infer<
  typeof internalCompletionRequestSchema
>;
