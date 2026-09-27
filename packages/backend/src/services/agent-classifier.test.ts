import { describe, expect, it } from "vitest";
import {
  AGENT_KEYS,
  classifyAgent,
  type AgentCategory,
} from "./agent-classifier.js";

function expectIdentity(
  userAgent: string | null | undefined,
  key: string,
  label: string,
  category: AgentCategory,
) {
  expect(classifyAgent(userAgent)).toEqual({ key, label, category });
}

describe("classifyAgent", () => {
  it("识别 Claude Code 终端客户端（claude-cli）", () => {
    expectIdentity(
      "claude-cli/1.0.51 (external, cli)",
      "claude-code",
      "Claude Code",
      "coding-agent",
    );
  });

  it("识别 Cursor", () => {
    expectIdentity("cursor/0.45.11", "cursor", "Cursor", "coding-agent");
  });

  it("识别其余编码代理与 worker / SDK / 脚本类", () => {
    expectIdentity("Windsurf/1.4.0", "windsurf", "Windsurf", "coding-agent");
    expectIdentity("cline/3.17.9 VSCode", "cline", "Cline", "coding-agent");
    expectIdentity("opencode/1.0.9", "opencode", "OpenCode", "coding-agent");
    expectIdentity("codex_cli_rs/0.2.0", "codex", "Codex", "coding-agent");
    expectIdentity("aider/0.79.0", "aider", "Aider", "coding-agent");
    expectIdentity("continue/0.8.53", "continue", "Continue", "coding-agent");
    expectIdentity(
      "craft-worker-asr_1234",
      "gateway-worker",
      "Gateway Worker",
      "worker",
    );
    // Playground 代理显式设的 loopback UA（routes/playground.ts）：不得落入 unknown。
    expectIdentity(
      "llm-gateway-playground",
      "gateway-playground",
      "Gateway Playground",
      "worker",
    );
    expectIdentity(
      "OpenAI/Python 1.54.0",
      "openai-sdk",
      "OpenAI SDK",
      "sdk",
    );
    expectIdentity(
      "Anthropic/Python 0.39.0",
      "anthropic-sdk",
      "Anthropic SDK",
      "sdk",
    );
  });

  it("识别 curl 与 python-requests", () => {
    expectIdentity("curl/8.6.0", "curl", "curl", "script");
    expectIdentity(
      "python-requests/2.32.3",
      "python-requests",
      "Python requests",
      "sdk",
    );
  });

  it("识别 node-fetch / axios / undici", () => {
    expectIdentity("node-fetch/3.3.2", "node-fetch", "node-fetch", "sdk");
    expectIdentity("axios/1.7.7", "axios", "axios", "sdk");
    expectIdentity("undici/7.10.0", "undici", "undici", "sdk");
  });

  it("识别 Chrome / Firefox / Safari 浏览器", () => {
    expectIdentity(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "browser",
      "Chrome",
      "browser",
    );
    expectIdentity(
      "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
      "browser",
      "Firefox",
      "browser",
    );
    expectIdentity(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      "browser",
      "Safari",
      "browser",
    );
  });

  it("Mozilla 但缺少排版引擎标识时不判为浏览器", () => {
    const ua = "Mozilla/5.0 (compatible; ConfluenceCrawler/1.0)";
    expectIdentity(ua, "unknown", ua.slice(0, 40), "unknown");
  });

  it("空 UA 与 null/undefined UA 归 unknown 并使用通用 label", () => {
    expectIdentity(null, "unknown", "Unknown client", "unknown");
    expectIdentity(undefined, "unknown", "Unknown client", "unknown");
    expectIdentity("", "unknown", "Unknown client", "unknown");
    expectIdentity("   ", "unknown", "Unknown client", "unknown");
  });

  it("未知 UA 的 label 取前 40 字符", () => {
    const ua =
      "some-internal-service/2.1.0 with a very long tail that exceeds the limit";
    const identity = classifyAgent(ua);
    expect(identity.key).toBe("unknown");
    expect(identity.category).toBe("unknown");
    expect(identity.label).toBe(ua.slice(0, 40));
    expect(identity.label.length).toBe(40);
  });

  it("大小写混合匹配（规则大小写不敏感）", () => {
    expectIdentity("CLAUDE-CLI/1.0.0", "claude-code", "Claude Code", "coding-agent");
    expectIdentity("CuRsOr/0.1.0", "cursor", "Cursor", "coding-agent");
    expectIdentity("Curl/8.6.0", "curl", "curl", "script");
    expectIdentity(
      "PYTHON-REQUESTS/2.32.3",
      "python-requests",
      "Python requests",
      "sdk",
    );
  });

  it("优先级：SDK 命名先于浏览器兜底，不被 Mozilla 前缀抢占", () => {
    expectIdentity(
      "OpenAI/NodeJS 4.73.0 Mozilla/5.0",
      "openai-sdk",
      "OpenAI SDK",
      "sdk",
    );
  });

  it("AGENT_KEYS 覆盖 classifyAgent 的全部输出 key", () => {    const samples: (string | null | undefined)[] = [
      "claude-cli/1.0.0",
      "cursor/1.0",
      "windsurf/1.0",
      "cline/1.0",
      "opencode/1.0",
      "codex/1.0",
      "aider/1.0",
      "continue/1.0",
      "craft-worker-x",
      "llm-gateway-playground",
      "OpenAI/JS 5.0.0",
      "Anthropic/JS 1.0",
      "curl/8.0",
      "python-requests/2.0",
      "node-fetch/3.0",
      "axios/1.0",
      "undici/7.0",
      "Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/133.0",
      "totally-unknown-thing/0.1",
      null,
    ];
    for (const ua of samples) {
      expect(AGENT_KEYS).toContain(classifyAgent(ua).key);
    }
  });
});
