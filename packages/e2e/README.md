# @llm-gateway/e2e

API 级端到端测试：启动真实后端（tsx 直跑 `packages/backend/src/index.ts`）+ 真实 MySQL（自动建库/迁移）+ 内置 mock upstream，覆盖原生协议转发、专家路由和流式续传。

## 覆盖

| 用例 | 链路 |
|---|---|
| `openai-chain.e2e.spec.ts` | `/v1/chat/completions` 非流式 + SSE 流式 |
| `anthropic-chain.e2e.spec.ts` | `/v1/messages`（x-api-key）非流式 + 流式 |
| `gemini-chain.e2e.spec.ts` | `/v1beta/models/{model}:generateContent`（x-goog-api-key）非流式 + `:streamGenerateContent?alt=sse` |
| `expert-routing.e2e.spec.ts` | JEV 分类器选档（medium）+ 分类器故障时 `fail_open=fallback` |
| `stream-resume.e2e.spec.ts` | Chat SSE 断链、429 重试、工具调用、客户端取消和二次失败 |
| `responses-chain.e2e.spec.ts` | `/v1/responses` 非流式（省略 `stream` 或显式 `false`）、请求 ID、用量和失败审计 |
| `responses-resume.e2e.spec.ts` | Responses SSE 续传、计费和失败审计 |

每条链路同时断言：响应语义、mock upstream 收到的 `model_identifier` 与鉴权、以及 `api_requests` 落库行（tokens/status/route_tier）——这层 DB 断言是 unit 层移除 SQL-shape 断言后的兜底。

## 运行

CI：`test.yml` 的 e2e job 用 GitHub Actions service container 起 MySQL 8.0，直接 `npm run test:e2e`。该命令先运行 mock upstream 独立自测，再运行依赖数据库的套件；后者排除自测，只执行一次 global setup。两个阶段均须成功。

只运行 mock upstream 自测（从仓库根目录，不需要 MySQL 或网关，使用临时端口）：

```bash
npm run test:e2e:mock-upstream
```

在 `packages/e2e` 目录也可使用同名脚本；`npm run test:e2e` 同样执行两个阶段。

本地（需要有 Docker，或已有 MySQL）：

```bash
docker run -d --name llm-gateway-e2e-mysql -p 3307:3306 \
  -e MYSQL_ROOT_PASSWORD=e2e-root-password mysql:8.0

MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=root \
MYSQL_PASSWORD=e2e-root-password npm run test:e2e
```

数据库套件每次运行都会 `DROP` 并重建 `llm_gateway_e2e` 数据库（可用 `MYSQL_DATABASE` 覆盖），请确保目标数据库可安全删除；独立自测不会连接或修改数据库。

## 续传用量与审计口径

`stream_resume_attempts` 是续写请求创建尝试次数，含被拒后重试，不含初始请求；成功续写仍最多采纳一段流。上游 journal 只记录实际到达的请求，因此连接失败未到达上游时不能要求两者相等。

续传后的网关用量是估算：原始客户端 prompt（Responses 的 `input`）计一次，已交付的文本增量计一次，合成的终态全文不重复计数。续写时重新发送的 prompt 不另计，因而它不等于上游两次调用的真实用量或成本。续写返回 `response.failed` 时记录 error 审计行；传输层二次中断的审计信息仍受失败路径可获得数据限制。

## 结构

- `vitest.mock-upstream.config.ts` — 独立自测配置，无 global setup；`vitest.config.ts` 排除该自测，供数据库套件使用。
- `global-setup.ts` — 建库 → 起 mock upstream（:3112）→ 起网关（:3111，等 `/health`）→ 走 admin API 播种（provider/models/虚拟密钥/专家路由）→ 写 `.e2e-context.json` 供用例读取；teardown 反向清理。
- `src/helpers/mock-upstream.ts` — 一台服务器模拟 OpenAI `/v1/chat/completions` 和 `/v1/responses`（非流式）、Anthropic `/v1/messages`、Gemini `/v1beta`、JEV classifier `/jev`；`/_internal/journal` 记录收到的请求供断言，`/_internal/jev-fail-mode` 注入分类器故障。
- `tests/` — 用例；`fileParallelism: false` 保证 journal 隔离。
