/**
 * 纯函数 UA → Agent 身份归类，供运维「Agent 使用统计」卡片使用。
 *
 * 只读取 UA 字符串本身、无副作用、规则表静态可单测。每条规则的注释标明
 * 依据的真实 UA 片段；仓库内无法证实的（craft worker）已显式标注假设。
 */

export type AgentCategory =
  | "coding-agent"
  | "sdk"
  | "script"
  | "browser"
  | "worker"
  | "unknown";

export interface AgentIdentity {
  key: string;
  label: string;
  category: AgentCategory;
}

interface AgentRule {
  identity: AgentIdentity;
  /** 对小写化 UA 求值；只依赖 UA 字符串。 */
  test: RegExp;
}

/**
 * 优先级自上而下：专用编码代理 > 本仓库 worker > 官方 SDK > 通用 HTTP 库 >
 * 浏览器 > 兜底 unknown。先于浏览器命中（例如内嵌 WebView 的 IDE 流量）。
 */
const RULES: readonly AgentRule[] = [
  {
    // 真实 UA：`claude-cli/1.0.51 (external, cli)`（Claude Code 终端客户端）。
    identity: { key: "claude-code", label: "Claude Code", category: "coding-agent" },
    test: /claude-(?:cli|code)\b/,
  },
  {
    // 真实 UA：`cursor/0.45.11`、`Cursor - AI Code Editor`。词边界避免误伤
    // 含 "cursor" 字样的无关词。
    identity: { key: "cursor", label: "Cursor", category: "coding-agent" },
    test: /\bcursor\b/,
  },
  {
    // 真实 UA：`Windsurf/1.4.0`（Codeium 编辑器）。
    identity: { key: "windsurf", label: "Windsurf", category: "coding-agent" },
    test: /\bwindsurf\b/,
  },
  {
    // 真实 UA：VS Code Cline 扩展 `cline/3.17.x`。
    identity: { key: "cline", label: "Cline", category: "coding-agent" },
    test: /\bcline\b/,
  },
  {
    // 真实 UA：`opencode/1.0.9 (external, cli)`。
    identity: { key: "opencode", label: "OpenCode", category: "coding-agent" },
    test: /\bopencode\b/,
  },
  {
    // 真实 UA：OpenAI Codex CLI `codex_cli_rs/0.2.0`（下划线属于词字符，
    // \b 无法切分，用显式的后接字符集匹配）。
    identity: { key: "codex", label: "Codex", category: "coding-agent" },
    test: /\bcodex(?=[-_\/\s]|$)/,
  },
  {
    // 真实 UA：`aider/0.79.0`。
    identity: { key: "aider", label: "Aider", category: "coding-agent" },
    test: /\baider\b/,
  },
  {
    // 真实 UA：Continue 插件 `continue/0.8.53`、`Continue 1.2.3`。
    identity: { key: "continue", label: "Continue", category: "coding-agent" },
    test: /\bcontinue\b/,
  },
  {
    // 真实 UA：`llm-gateway-playground`——由 routes/playground.ts 的 loopback
    // 请求显式设置（已实测落入 api_requests.user_agent）。不先于 worker 规则
    // 命中会把 Playground 流量归入 unknown，与“谁在调我的网关”相背。
    identity: {
      key: "gateway-playground",
      label: "Gateway Playground",
      category: "worker",
    },
    test: /llm-gateway-playground/,
  },
  {
    // 假设：本仓库 craft worker（packages/worker）经 Node fetch 回调
    // /api/internal/agent/completions，源码未显式设置 User-Agent；
    // 仓库内可证实的标识只有容器名 `craft-worker-<runId>`
    // （agent/run/executors.ts）与 stderr 前缀 `[craft-worker-local]`。
    // 故按 craft-worker 匹配，并防御性带上 llm-gateway-worker（约定中的
    // 未来显式 UA）。若 worker 日后显式设置 UA，改这一条即可。
    identity: { key: "gateway-worker", label: "Gateway Worker", category: "worker" },
    test: /craft-worker|llm-gateway-worker/,
  },
  {
    // 真实 UA：`OpenAI/Python 1.54.0`、`OpenAI/NodeJS 4.73.0`、
    // `OpenAI/JS 5.0.0`（stainless 生成器均带 `OpenAI/<runtime>` 前缀）。
    // brief 里的 `/sdk-` 片段单看过于宽泛，未采用（见报告假设）。
    identity: { key: "openai-sdk", label: "OpenAI SDK", category: "sdk" },
    test: /openai\/(?:python|nodejs|js|java|go|dotnet|ruby)\b|\bopenai-sdk\b/,
  },
  {
    // 真实 UA：`Anthropic/Python 0.39.0`、`AnthropicBedrock/...`、
    // `anthropic-ai/sdk`。仓库 routes/anthropic 实际并不下发 user-agent
    // （http-client.ts 只组装 anthropic-version/x-api-key），故以官方 SDK
    // 的公开 UA 为准；anthropic-beta 是 header 名，防御性保留匹配。
    identity: { key: "anthropic-sdk", label: "Anthropic SDK", category: "sdk" },
    test:
      /anthropic\/(?:python|nodejs|js|typescript|bedrock)\b|\banthropic-ai\b|anthropic-beta/,
  },
  {
    // 真实 UA：`curl/8.6.0`。
    identity: { key: "curl", label: "curl", category: "script" },
    test: /\bcurl\//,
  },
  {
    // 真实 UA：`python-requests/2.32.3`。
    identity: { key: "python-requests", label: "Python requests", category: "sdk" },
    test: /\bpython-requests\b/,
  },
  {
    // 真实 UA：`node-fetch/3.3.2`。
    identity: { key: "node-fetch", label: "node-fetch", category: "sdk" },
    test: /\bnode-fetch\b/,
  },
  {
    // 真实 UA：`axios/1.7.7`。
    identity: { key: "axios", label: "axios", category: "sdk" },
    test: /\baxios\//,
  },
  {
    // 真实 UA：undici（Node 内置 fetch 底层）`undici/7.10.0`、`node`。
    identity: { key: "undici", label: "undici", category: "sdk" },
    test: /\bundici\b/,
  },
];

/** 浏览器判定：必须有 Mozilla/5.0 前缀且带排版引擎标识。 */
const MOZILLA_PREFIX = /^mozilla\/5\.0/;
const ENGINE_MARKERS = /applewebkit|gecko|presto/;

function classifyBrowser(ua: string): AgentIdentity {
  // Chrome/Chromium 合并标注；Edge(Edg/) 也含 Chrome，按 brief 只区分
  // Chrome/Firefox/Safari，Edge 归入 Chrome（见报告假设）。
  if (/chrome|chromium/.test(ua)) {
    return { key: "browser", label: "Chrome", category: "browser" };
  }
  if (/firefox/.test(ua)) {
    return { key: "browser", label: "Firefox", category: "browser" };
  }
  if (/\bsafari\b/.test(ua)) {
    return { key: "browser", label: "Safari", category: "browser" };
  }
  return { key: "browser", label: "Browser", category: "browser" };
}

const UNKNOWN_LABEL_MAX = 40;
const UNKNOWN_IDENTITY: AgentIdentity = {
  key: "unknown",
  label: "Unknown client",
  category: "unknown",
};

export function classifyAgent(userAgent: string | null | undefined): AgentIdentity {
  if (userAgent === null || userAgent === undefined) return UNKNOWN_IDENTITY;
  const ua = userAgent.trim();
  if (!ua) return UNKNOWN_IDENTITY;
  const lower = ua.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(lower)) return rule.identity;
  }
  if (MOZILLA_PREFIX.test(lower) && ENGINE_MARKERS.test(lower)) {
    return classifyBrowser(lower);
  }
  return {
    key: UNKNOWN_IDENTITY.key,
    label: ua.slice(0, UNKNOWN_LABEL_MAX),
    category: "unknown",
  };
}

/**
 * classifyAgent 可能输出的全部 key（规则表静态可枚举），供路由层做
 * `/coding-agents/:key` 的合法 key 白名单校验。
 */
export const AGENT_KEYS: readonly string[] = [
  ...new Set(RULES.map((rule) => rule.identity.key)),
  "browser",
  "unknown",
];
