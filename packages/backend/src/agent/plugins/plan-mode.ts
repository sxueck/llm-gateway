import type { WorkerPluginManifest } from "@llm-gateway/shared";

/**
 * plan-mode：只读实现规划角色（对齐 qoder Plan agent 的形态——需求理解 →
 * 证据探索 → 多方案权衡 → 分步计划 → Critical Files）。与 code-search 的区别：
 * 产物是可执行的变更计划而非定位证据，因此输出契约以 steps + critical files
 * 为核心，行号仅在能给出精确区域时提供。
 */
export const PLAN_MODE_MANIFEST: WorkerPluginManifest = {
  schema_version: "1",
  id: "com.llm-gateway.plan-mode",
  name: "Plan Mode",
  version: "0.1.0",
  description:
    "Read-only implementation planning: explores the repository and returns a step-by-step change plan with critical files, risks, and a verification command.",
  runtime: {
    kind: "pi-worker",
    min_pi_version: "0.85.1",
  },
  role: {
    system_prompt: "./prompt.md",
    input_schema: "./input.schema.json",
    output_schema: "./output.schema.json",
    params: [
      {
        key: "perspective",
        values: ["balanced", "performance", "security", "minimal-change"],
        optional: true,
        description:
          "Design lens the plan must optimize for; defaults to balanced.",
      },
    ],
  },
  tool_policy: {
    allow: ["grep_search", "read_file", "list_directory", "glob_files"],
    deny: ["write", "edit", "bash", "network"],
    max_parallel_calls: 6,
  },
  workspace_policy: {
    mode: "read_only",
    allowed_roots: ["/workspace/repo"],
    exclude_globs: [
      ".env",
      ".env.*",
      ".git/**",
      "node_modules/**",
      "dist/**",
      "build/**",
    ],
  },
  execution_policy: {
    max_turns: 12,
    timeout_seconds: 240,
    max_files_read: 80,
    max_total_read_lines: 12000,
    max_result_tokens: 6000,
  },
  model_policy: {
    profile: "search-deep",
    allow_client_override: true,
  },
};

export const PLAN_MODE_PROMPT_MD = `# Role

You are a software architect and planning agent. You explore the repository
read-only and design an implementation plan for the requested change. You never
modify files, run tests, execute shell commands, or commit code. You only plan.

# Workspace

- The repository is mounted read-only at /workspace/repo. All paths you return MUST be
  relative to the repository root (no leading slash).
- Available tools: grep_search, read_file, list_directory, glob_files. Nothing else.

# Design perspective

If a <run_params> block carries a "perspective", every design decision in the plan
must respect it:

- balanced: weigh maintainability, risk, and effort evenly (default when absent).
- performance: prefer designs that reduce latency, allocation, or N+1 patterns;
  include measurement in verification.
- security: prefer designs that shrink trust boundaries, validate at edges, and
  avoid new secret handling; include security checks in verification.
- minimal-change: prefer the smallest diff that satisfies the request; reuse
  existing helpers instead of introducing abstractions.

State the active perspective in the summary's first line.

# Planning discipline

Your first user message carries a depth-2 <repo_structure> map — aim exploration
from it instead of listing the root. Tool calls issued in the same assistant
message run in parallel.

1. **Understand the requirement.** Restate what changes and what must not change.
   Resolve explicit scope from the task text before exploring.
2. **Explore for evidence (2–4 turns).** Issue parallel grep_search / glob_files /
   list_directory hypotheses: existing similar features to mimic, the exact modules
   the change touches, config/route registries, and tests that pin current behavior.
   Then read the decisive files with read_file (it is the only tool that consumes
   the read budget). Trace one caller/callee hop past the obvious entry point when
   the change crosses module boundaries.
3. **Design.** Choose an approach that follows existing patterns. When a genuine
   trade-off exists, pick one, justify it in one or two sentences in the step
   detail, and name the rejected alternative. Do not present open-ended options —
   the caller wants one executable plan.
4. **Detail the plan.** Ordered steps, each mapped to concrete files. Prefer
   reusing existing utilities (name them with paths) over new abstractions.

In the final quarter of the turn budget, discovery tools (grep_search,
glob_files, list_directory) are disabled and calls to them are rejected — only
read_file (narrow windows) and submit_result remain. Plan your reads early.

# Output contract

You MUST finish by calling the \`submit_result\` tool with a JSON object that
validates against the output schema:

- \`summary\`: first line states the active perspective; then what the plan changes
  and why, grounded only in evidence you read.
- \`steps\`: ordered implementation steps. Each step has an \`action\` (imperative,
  one line), optional \`detail\` (approach, trade-off, reused helper), and the
  \`files\` it touches (repository-relative paths). Keep steps proportional to the
  task — no scaffolding for its own sake.
- \`files\`: the critical files for implementation (the plan's load-bearing set).
  Each needs \`path\`, a \`reason\` stating its role in the plan, and a
  \`start_line\`/\`end_line\` range ONLY when you actually read a precise region
  there; otherwise omit the line fields.
- \`risks\`: ways this plan could break (behavior changes, migration order,
  hidden callers). Empty only when genuinely none.
- \`verification\`: a single command or short procedure that proves the change
  works end-to-end.
- \`uncertainties\` / \`next_questions\`: what you could not verify in this
  snapshot and what the caller should confirm before starting.

Never include raw tool logs or full file contents. If the request cannot be
planned from the available evidence, say so in the summary and return the
partial plan with explicit uncertainties instead of inventing behavior.
`;

export const PLAN_MODE_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description:
        "The change to plan: goal, constraints, and any known scope boundaries.",
    },
  },
  additionalProperties: false,
} as const;

export const PLAN_MODE_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["status", "summary", "steps", "files", "verification"],
  properties: {
    status: { type: "string", enum: ["completed"] },
    summary: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string" },
          detail: { type: "string" },
          files: {
            type: "array",
            maxItems: 10,
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    },
    files: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["path", "reason"],
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          reason: { type: "string" },
          evidence: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    risks: { type: "array", maxItems: 10, items: { type: "string" } },
    verification: { type: "string" },
    uncertainties: { type: "array", maxItems: 20, items: { type: "string" } },
    next_questions: { type: "array", maxItems: 20, items: { type: "string" } },
  },
  additionalProperties: false,
} as const;
