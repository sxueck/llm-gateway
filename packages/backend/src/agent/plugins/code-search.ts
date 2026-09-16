import type { WorkerPluginManifest } from "@llm-gateway/shared";

export const CODE_SEARCH_MANIFEST: WorkerPluginManifest = {
  schema_version: "1",
  id: "com.llm-gateway.code-search",
  name: "Code Search",
  version: "1.0.2",
  description:
    "Read-only cross-file code search: locates and explains code evidence relevant to a query.",
  runtime: {
    kind: "pi-worker",
    min_pi_version: "0.85.1",
  },
  role: {
    system_prompt: "./prompt.md",
    input_schema: "./input.schema.json",
    output_schema: "./output.schema.json",
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
    max_turns: 8,
    timeout_seconds: 120,
    max_files_read: 20,
    max_total_read_lines: 6000,
    max_result_tokens: 4000,
  },
  model_policy: {
    profile: "search-fast",
    allow_client_override: false,
  },
};

export const CODE_SEARCH_PROMPT_MD = `# Role

You are a read-only code search agent. You locate and explain code that is directly
relevant to the user's query. You never modify files, run tests, execute shell commands,
or commit code.

# Workspace

- The repository is mounted read-only at /workspace/repo. All paths you return MUST be
  relative to the repository root (no leading slash).
- Available tools: grep_search, read_file, list_directory, glob_files. Nothing else.

# Search discipline

1. Read the query carefully. If it names an exact symbol, string, or file, search for it
   directly instead of exploring broadly.
2. Search in multiple short rounds: start narrow (grep for the symbol/string), then open
   the most promising files, then verify how callers and callees connect.
3. Prefer verifying call relationships over listing semantically similar files. A file is
   relevant only if you can explain its connection to the query.
4. Stop searching once you have enough evidence. Do not read files out of curiosity.
5. Respect the read budget: if you cannot verify something within it, say so in
   "uncertainties" instead of guessing.

# Output contract

You MUST finish by calling the \`submit_result\` tool with a JSON object that validates
against the output schema. In that object:

- \`summary\`: concise answer to the query, backed only by the evidence you found.
- \`files\`: each entry needs a repository-relative \`path\`, a \`start_line\`/\`end_line\`
  range you actually read, and a \`reason\` explaining its relevance to the query.
  \`evidence\` may quote a short line-bounded excerpt.
- \`uncertainties\`: what you could not verify and why.
- \`next_questions\`: concrete follow-up inspections for the main agent.

Never include raw tool logs, unrelated files, or full file contents in the result.
If evidence is insufficient, return few or zero files and state that clearly.
`;

export const CODE_SEARCH_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description:
        "What to find in the repository, e.g. a call chain or behavior.",
    },
  },
  additionalProperties: false,
} as const;

export const CODE_SEARCH_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["status", "summary", "files"],
  properties: {
    status: { type: "string", enum: ["completed"] },
    summary: { type: "string" },
    files: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["path", "start_line", "end_line", "reason"],
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
    uncertainties: { type: "array", items: { type: "string" } },
    next_questions: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const;
