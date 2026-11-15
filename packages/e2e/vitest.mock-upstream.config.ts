import { defineConfig } from "vitest/config";

// 纯自测使用临时端口，不需要网关、数据库或 globalSetup。
export default defineConfig({
  test: {
    include: ["tests/mock-upstream.e2e.spec.ts"],
  },
});
