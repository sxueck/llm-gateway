import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";
import { MOCK_PORT, requireMysqlEnv, GATEWAY_PORT } from "./src/helpers/env.js";
import { startMockUpstream } from "./src/helpers/mock-upstream.js";
import { startGateway } from "./src/helpers/gateway.js";
import { recreateDatabase } from "./src/helpers/db.js";
import { seedViaAdminApi } from "./src/helpers/admin-api.js";
import type { E2EContext } from "./src/helpers/context.js";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url)); // packages/e2e
const CONTEXT_FILE = path.join(PKG_DIR, ".e2e-context.json");

export default async function setup(_opts: GlobalSetupContext): Promise<() => Promise<void>> {
  const mysql = requireMysqlEnv();
  await recreateDatabase(mysql);

  const mock = await startMockUpstream();
  const gateway = await startGateway(mysql, `${mock.baseUrl}/jev`);

  let seed;
  try {
    seed = await seedViaAdminApi(gateway.baseUrl, mock.baseUrl);
  } catch (e) {
    await gateway.stop();
    await mock.close();
    throw e;
  }

  const ctx: E2EContext = {
    gatewayBaseUrl: gateway.baseUrl,
    mockBaseUrl: mock.baseUrl,
    virtualKeys: seed.virtualKeys,
    models: { openai: "gpt-e2e", anthropic: "claude-e2e", gemini: "gemini-e2e" },
    identifiers: { openai: "mock-gpt", anthropic: "mock-claude", gemini: "mock-gemini" },
    expertVirtualModel: seed.expertVirtualModelName,
    expertUpstreamModels: seed.expertUpstreamModels,
    mysql,
  };
  writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
  console.log(
    `[e2e] gateway on :${GATEWAY_PORT}, mock upstream on :${MOCK_PORT}, db=${mysql.database}, exposed expert model="${ctx.expertVirtualModel}"`,
  );

  return async () => {
    await gateway.stop();
    await mock.close();
    rmSyncQuiet(CONTEXT_FILE);
  };
}

function rmSyncQuiet(file: string): void {
  try {
    // teardown 尽力而为：上下文文件残留只影响下次运行的初值
    rmSync(file, { force: true });
  } catch {
    // ignore
  }
}
