# @llm-gateway/e2e

API 级端到端测试：启动真实后端（tsx 直跑 `packages/backend/src/index.ts`）+ 真实 MySQL（自动建库/迁移）+ 内置 mock upstream，覆盖三条原生转发链路与专家路由。

## 覆盖

| 用例 | 链路 |
|---|---|
| `openai-chain.e2e.spec.ts` | `/v1/chat/completions` 非流式 + SSE 流式 |
| `anthropic-chain.e2e.spec.ts` | `/v1/messages`（x-api-key）非流式 + 流式 |
| `gemini-chain.e2e.spec.ts` | `/v1beta/models/{model}:generateContent`（x-goog-api-key）非流式 + `:streamGenerateContent?alt=sse` |
| `expert-routing.e2e.spec.ts` | JEV 分类器选档（medium）+ 分类器故障时 `fail_open=fallback` |

每条链路同时断言：响应语义、mock upstream 收到的 `model_identifier` 与鉴权、以及 `api_requests` 落库行（tokens/status/route_tier）——这层 DB 断言是 unit 层移除 SQL-shape 断言后的兜底。

## 运行

CI：`test.yml` 的 e2e job 用 GitHub Actions service container 起 MySQL 8.0，直接 `npm run test:e2e`。

本地（需要有 Docker，或已有 MySQL）：

```bash
docker run -d --name llm-gateway-e2e-mysql -p 3307:3306 \
  -e MYSQL_ROOT_PASSWORD=e2e-root-password mysql:8.0

MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=root \
MYSQL_PASSWORD=e2e-root-password npm run test:e2e
```

套件每次运行都会 `DROP` 并重建 `llm_gateway_e2e` 数据库（可用 `MYSQL_DATABASE` 覆盖），不会触碰开发库。

## 结构

- `global-setup.ts` — 建库 → 起 mock upstream（:3112）→ 起网关（:3111，等 `/health`）→ 走 admin API 播种（provider/models/虚拟密钥/专家路由）→ 写 `.e2e-context.json` 供用例读取；teardown 反向清理。
- `src/helpers/mock-upstream.ts` — 一台服务器扮演四种上游：OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`、Gemini `/v1beta`、JEV classifier `/jev`；`/_internal/journal` 记录收到的请求供断言，`/_internal/jev-fail-mode` 注入分类器故障。
- `tests/` — 用例；`fileParallelism: false` 保证 journal 隔离。
