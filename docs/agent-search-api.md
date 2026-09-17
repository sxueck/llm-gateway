# Agent Search（代码检索）API 使用教程

## 概述

Agent Search 是网关提供的**只读跨文件代码检索**能力：其将一个代码库以「快照」形式上传到网关，然后用虚拟密钥发起一次检索 run，网关在沙箱容器（pi-worker）中运行内置的 `code-search` 插件——一个多轮 tool-use 检索 agent，最终在仓库内定位并解释与查询相关的代码证据，返回结构化结果（summary + 带行号的文件证据列表）。

完整链路：

```
上传快照 → finalize → 创建检索 run → (SSE 事件流) → 轮询结果
```

特点：

- **只读安全**：worker 以只读 workspace 运行，禁止写文件、执行 shell、访问网络；可用工具仅 `grep_search` / `read_file` / `list_directory` / `glob_files`。
- **密钥隔离**：全程只需一个虚拟密钥（`Authorization: Bearer <key>`），worker 接触不到 provider key，也接触不到你的虚拟密钥。
- **计量归户**：检索消耗的模型 token / 费用记账到发起 run 的虚拟密钥名下，可在管理端查看。

## 前置条件

1. **虚拟密钥**：在 Web UI 或 `/api/admin/virtual-keys` 创建一个启用状态的虚拟密钥。
2. **内置插件已 seed**：`com.llm-gateway.code-search@1.0.5` 在后端启动时自动发布（幂等 seed），无需手动操作。可用管理端 `GET /api/admin/worker-plugins` 查看当前可用版本，创建 run 时填的 `version` 必须与已发布版本一致。
3. **模型 profile 已配置**：插件固定使用模型 profile `search-fast`（`allow_client_override: false`，客户端不可覆盖）。网关中必须存在一个**名称恰好为 `search-fast` 且启用**的模型（`models` 表按 `name` 精确匹配，不走别名），建议将其绑定到一个快速、非 reasoning 的模型上，否则检索会很慢。未配置时创建 run 会返回 `model_profile_not_configured`。
4. **Docker 可用**：每个 run 由网关通过 dockerode 启动一个一次性容器（`craft-worker-<runId>`）执行。compose 部署已带 `/var/run/docker.sock` 挂载；二进制部署需要本机 Docker。

## Step 1：上传代码快照

快照是检索的代码来源（当前仅支持 `pi_local_worktree` 类型，即客户端本地工作区打包上传）。快照创建后 **24 小时过期**。

### 1.1 创建快照

`POST /api/agent/snapshots`

```bash
curl -X POST http://localhost:3000/api/agent/snapshots \
  -H "Authorization: Bearer $VKEY" \
  -H "Content-Type: application/json" \
  -d @snapshot-request.json
```

`snapshot-request.json`（manifest 列出每个文件的 path / sha256 / size，以及被排除的文件和原因）：

```json
{
  "source": "pi_local_worktree",
  "repository": {
    "display_name": "my-repo",
    "git_remote": "https://github.com/acme/my-repo.git",
    "head_commit": "a1b2c3d"
  },
  "manifest": {
    "format_version": 1,
    "files": [
      { "path": "src/index.ts", "sha256": "<sha256-hex>", "size": 1234, "language": "typescript" }
    ],
    "excluded": [
      { "path": ".env", "reason": "forbidden by platform policy" }
    ]
  }
}
```

限制与强制排除（服务端会拒绝接收）：

- 单快照最多 **20,000 个文件**、总大小 **200 MB**、单文件 **10 MB**。
- 强制排除：`.env`、`.env.*`、`.git/**`、`node_modules/**`、`dist/**`、`build/**`、`coverage/**`、`*.pem` / `*.key` / `*.p12` / `*.crt`、`id_rsa*`、`credentials*`、`auth.json`（对任意目录深度生效）。

响应 `201`：

```json
{
  "snapshot_id": "snap_xxx",
  "status": "uploading",
  "file_count": 120,
  "total_size": 345678,
  "expires_at": 1735689600000,
  "object_upload_path_template": "/api/agent/snapshots/snap_xxx/objects/{file_path}",
  "finalize_url": "/api/agent/snapshots/snap_xxx/finalize"
}
```

### 1.2 逐个上传文件内容

`PUT /api/agent/snapshots/:id/objects/<url-encoded 相对路径>`，body 为原始文件字节（`application/octet-stream`）。服务端校验 sha256，不匹配返回 `hash_mismatch`。

```bash
curl -X PUT "http://localhost:3000/api/agent/snapshots/snap_xxx/objects/src%2Findex.ts" \
  -H "Authorization: Bearer $VKEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @src/index.ts
```

### 1.3  finalize

所有文件上传完成后 finalize，状态变为 `ready` 才能用于检索：

```bash
curl -X POST http://localhost:3000/api/agent/snapshots/snap_xxx/finalize \
  -H "Authorization: Bearer $VKEY"
```

漏传文件会返回 `incomplete`。随时可用 `GET /api/agent/snapshots/:id` 查询状态；`DELETE /api/agent/snapshots/:id` 删除。

> 批量上传示例脚本见文末「端到端示例」。

## Step 2：创建检索 run

`POST /api/agent/searches`

```bash
curl -X POST http://localhost:3000/api/agent/searches \
  -H "Authorization: Bearer $VKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": { "id": "com.llm-gateway.code-search", "version": "1.0.5" },
    "source": { "type": "snapshot", "snapshot_id": "snap_xxx" },
    "query": "请求从 /v1/chat/completions 进入后是如何路由到具体 provider 的？",
    "options": {}
  }'
```

字段说明：

- `plugin.id` / `plugin.version`：插件坐标，版本必须与已发布的一致。
- `source.type`：目前仅支持 `"snapshot"`。
- `query`：检索问题（1–8000 字符）。好的 query 是具体的行为/调用链问题，而不是关键词堆砌。
- `options.model_profile`：一般不要传；插件固定 `search-fast` 且禁止覆盖，传了会返回 `model_profile_override_forbidden`（403）。

响应 `202`（异步受理）：

```json
{
  "run_id": "asr_xxx",
  "status": "queued",
  "plugin": { "id": "com.llm-gateway.code-search", "version": "1.0.5", "digest": "sha256:..." },
  "model_profile": "search-fast",
  "events_url": "/api/agent/searches/asr_xxx/events",
  "result_url": "/api/agent/searches/asr_xxx",
  "expires_at": 1735689600000
}
```

常见错误：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `unknown_plugin` | 插件 id/version 未发布 |
| 403 | `plugin_revoked` | 插件已被吊销 |
| 400 | `model_profile_not_configured` | 网关没有名为 `search-fast` 的启用模型 |
| 409 | `snapshot_not_ready` | 快照未 finalize |
| 410 | `snapshot_expired` | 快照已过期 |
| 429 | `queue_full` | 排队 run 超过 200 上限 |

## Step 3：获取结果

### 3.1 轮询（推荐）

`GET /api/agent/searches/:id`

```bash
curl http://localhost:3000/api/agent/searches/asr_xxx \
  -H "Authorization: Bearer $VKEY"
```

响应（completed）：

```json
{
  "run_id": "asr_xxx",
  "status": "completed",
  "plugin": { "id": "...", "version": "1.0.5", "digest": "sha256:..." },
  "source": { "type": "snapshot", "snapshot_id": "snap_xxx", "commit": "a1b2c3d" },
  "model_profile": "search-fast",
  "created_at": 1735603200000,
  "started_at": 1735603203000,
  "completed_at": 1735603212000,
  "expires_at": 1735689600000,
  "error": null,
  "usage": { "turns": 4, "tool_calls": 7, "input_tokens": 31204, "output_tokens": 1203, "cost": 0.0018 },
  "result": {
    "run_id": "asr_xxx",
    "status": "completed",
    "repository": { "source_type": "snapshot", "snapshot_id": "snap_xxx", "commit": "a1b2c3d" },
    "summary": "请求在 routes/proxy/... 中经过 model-resolver 解析……",
    "files": [
      {
        "path": "packages/backend/src/routes/proxy/index.ts",
        "start_line": 88,
        "end_line": 142,
        "reason": "chat completions 路由入口，调用 model-resolver",
        "evidence": "const resolved = await resolveModel(...)"
      }
    ],
    "uncertainties": [],
    "next_questions": ["fallback 策略在 resolveProvider 中如何选择下一个 provider？"],
    "usage": { "plugin": "com.llm-gateway.code-search", "model_profile": "search-fast", "turns": 4, "tool_calls": 7, "input_tokens": 31204, "output_tokens": 1203, "cost": 0.0018 }
  }
}
```

- `status` 生命周期：`queued → running → completed / failed / cancelled / timed_out / budget_exceeded`；终止态超过 `expires_at`（创建后 24h）后返回 `expired`，且 `result` 不再可读——请及时取回结果。
- `result.files[].path` 为仓库根相对路径；`start_line`/`end_line` 是 agent 实际读过的行区间。
- `result` 只有 `completed` 时非空；失败时看 `error.code` / `error.message`。

### 3.2 SSE 事件流（需要实时进度时）

`GET /api/agent/searches/:id/events`，标准 Server-Sent Events：

```bash
curl -N http://localhost:3000/api/agent/searches/asr_xxx/events \
  -H "Authorization: Bearer $VKEY"
```

每条事件格式：

```
id: 12
event: tool.completed
data: {"run_id":"asr_xxx","seq":12,"type":"tool.completed","payload":{...},"created_at":1735603204000}
```

事件类型：`run.queued`、`run.started`、`source.resolved`、`worker.started`、`tool.started`、`tool.completed`、`model.completed`（进度类），终态事件 `run.completed` / `run.failed` / `run.cancelled` 后服务端自动关闭流。断线重连用请求头 `Last-Event-ID` 或查询参数 `?after=<seq>` 从上次序号续传；流内有 15s 心跳注释 `: ping`。

### 3.3 取消

`POST /api/agent/searches/:id/cancel`（幂等，对终止态 run 是 no-op）：

```bash
curl -X POST http://localhost:3000/api/agent/searches/asr_xxx/cancel \
  -H "Authorization: Bearer $VKEY"
```

## 配额与行为说明

由插件 `execution_policy` 决定（v1.0.5）：

- 最多 **8 轮**对话、总超时 **120 秒**。
- 读预算：最多 **60 个文件 / 累计 9000 行**；结果输出上限 **4000 tokens**。
- 收敛机制：turn 预算的最后 1/4 起禁用发现类工具（grep_search / glob_files / list_directory），只允许 read_file 窄窗口和 submit_result，防止 agent 漫游耗尽预算。
- `grep_search` 每文件最多返回 5 条匹配（带 `…N more` 提示），支持 `context_lines`（0–3）一次取上下文。

## 端到端示例

以下脚本把一个 git 仓库打包成快照并发起检索：

```bash
#!/usr/bin/env bash
set -euo pipefail
GW=${GW:-http://localhost:3000}
VKEY=${VKEY:?set VKEY to your virtual key}
REPO_DIR=${1:?usage: $0 <repo-dir> <query>}
QUERY=${2:?usage: $0 <repo-dir> <query>}
cd "$REPO_DIR"

# 生成 manifest：仅收集未被强制排除的文件
FILES_JSON=$(git ls-files -z \
  | grep -zvE '(^|/)(\.env(\..*)?|\.git/|node_modules/|dist/|build/|coverage/)' \
  | grep -zvE '\.(pem|key|p12|crt)$' \
  | while IFS= read -r -d '' f; do
      sha=$(sha256sum "$f" | cut -d' ' -f1)
      size=$(stat -c%s "$f")
      printf '{"path":"%s","sha256":"%s","size":%s},' "$f" "$sha" "$size"
    done | sed 's/,$//')

SNAP=$(curl -sf -X POST "$GW/api/agent/snapshots" \
  -H "Authorization: Bearer $VKEY" -H "Content-Type: application/json" \
  -d "{\"source\":\"pi_local_worktree\",\"repository\":{\"display_name\":\"$(basename "$PWD")\",\"head_commit\":\"$(git rev-parse --short HEAD 2>/dev/null || true)\"},\"manifest\":{\"format_version\":1,\"files\":[${FILES_JSON}],\"excluded\":[]}}")
SNAP_ID=$(echo "$SNAP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["snapshot_id"])')
echo "snapshot: $SNAP_ID"

git ls-files -z \
  | grep -zvE '(^|/)(\.env(\..*)?|\.git/|node_modules/|dist/|build/|coverage/)' \
  | grep -zvE '\.(pem|key|p12|crt)$' \
  | while IFS= read -r -d '' f; do
      curl -sf -X PUT "$GW/api/agent/snapshots/$SNAP_ID/objects/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$f")" \
        -H "Authorization: Bearer $VKEY" -H "Content-Type: application/octet-stream" \
        --data-binary "@$f"
    done
curl -sf -X POST "$GW/api/agent/snapshots/$SNAP_ID/finalize" -H "Authorization: Bearer $VKEY" > /dev/null
echo "snapshot ready"

RUN=$(curl -sf -X POST "$GW/api/agent/searches" \
  -H "Authorization: Bearer $VKEY" -H "Content-Type: application/json" \
  -d "{\"plugin\":{\"id\":\"com.llm-gateway.code-search\",\"version\":\"1.0.5\"},\"source\":{\"type\":\"snapshot\",\"snapshot_id\":\"$SNAP_ID\"},\"query\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$QUERY")}")
RUN_ID=$(echo "$RUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run_id"])')
echo "run: $RUN_ID"

while :; do
  STATUS=$(curl -sf "$GW/api/agent/searches/$RUN_ID" -H "Authorization: Bearer $VKEY")
  S=$(echo "$STATUS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  echo "status: $S"
  case "$S" in
    completed|failed|cancelled|timed_out|budget_exceeded|expired) break ;;
  esac
  sleep 3
done
echo "$STATUS" | python3 -m json.tool
```

## 附录：worker 内部协议（自定义 worker 开发参考）

以下端点面向网关拉起的 worker 容器，**不面向终端用户**，鉴权使用一次性 service token（`X-Agent-Service-Token` 头，由网关在创建 run 时生成并注入容器环境变量 `AGENT_SERVICE_TOKEN`）。列出仅供开发自定义插件/worker 时参考：

| 端点 | 说明 |
| --- | --- |
| `POST /api/internal/agent/completions` | worker 的模型通道。body 需含 `run_id`、`model_profile`（必须与 run 绑定值一致）、`turn`、`messages`、`tools`、`max_tokens`。网关注入 `x-agent-loopback` 后借道 `/v1/chat/completions` 的完整路由/fallback/计量链路，用量记账到 run 归属的虚拟密钥。响应为 OpenAI chat completion JSON（非流式）。 |
| `POST /api/internal/agent/runs/:runId/events` | 上报进度事件，仅白名单 `tool.started` / `tool.completed` / `model.completed`（204）。 |
| `POST /api/internal/agent/runs/:runId/report` | 上报终态：`kind` 为 `completed`（带 result + usage）/ `failed`（error_code + error_message）/ `budget_exceeded`。终态必须送达，否则 scheduler 按 `worker_exited_without_result` 判失败。 |

worker 容器启动环境变量：`AGENT_PLUGIN_FILE`（插件 bundle + query 的 JSON 文件）、`AGENT_RUN_ID`、`AGENT_GATEWAY_INTERNAL_URL`（内部地址，走 host-gateway）、`AGENT_SERVICE_TOKEN`、`AGENT_WORKSPACE_ROOT`（默认 `/workspace/repo`，只读挂载）。参考实现见 `packages/worker/src/`。

> 注意：`x-agent-loopback` token 是单进程内存随机值，模型 profile 的 loopback 解析仅在网关单进程部署下生效。
