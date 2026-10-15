import { readFileSync } from "node:fs";

export interface E2EContext {
  gatewayBaseUrl: string;
  mockBaseUrl: string;
  /** key = 网关侧模型名（含 expert 虚拟模型），value = 虚拟密钥明文 */
  virtualKeys: Record<string, string>;
  models: {
    openai: string; // 网关侧模型名，如 gpt-e2e
    anthropic: string;
    gemini: string;
  };
  identifiers: {
    openai: string; // 上游 mock 侧 model_identifier
    anthropic: string;
    gemini: string;
  };
  expertVirtualModel: string;
  expertUpstreamModels: { low: string; medium: string; high: string };
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

export function loadContext(file: string | undefined): E2EContext {
  if (!file) throw new Error("E2E_CONTEXT_FILE is not set (vitest.config env)");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as E2EContext;
  } catch (e) {
    throw new Error(`cannot load E2E context file "${file}": ${(e as Error).message}`);
  }
}
