import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.e2e.spec.ts"],
    // 全部用例共享同一网关进程与 journal，文件并行会互相污染断言
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: [path.resolve(PKG_DIR, "global-setup.ts")],
    env: {
      // 绝对路径：worker 的 process.cwd 是仓库根，相对路径会指错
      E2E_CONTEXT_FILE: path.join(PKG_DIR, ".e2e-context.json"),
    },
  },
});
