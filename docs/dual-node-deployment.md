# 跨地域双节点：固定供应商 owner

本方案在两个相距遥远的地点各运行一个网关进程（下例用 `node-a` 表示控制节点、`node-b` 表示另一地节点；节点 ID 只是标识符，可自行命名）。两地均接收模型 API 请求，供应商只在固定 owner 节点执行；owner 故障时不接管，不引入 Redis 或跨地域数据库双写。

价值来自出口位置：靠近供应商的那一侧执行该供应商的请求，跨境链路上只走内部 dispatch。

```text
客户端 → node-a API ─┬─ owner=node-a → A 地供应商
                    └─ 内部 dispatch → node-b API → owner=node-b 的供应商
客户端 → node-b API：同样按 owner 本地执行或交给 node-a

node-a（控制节点）：管理后台、登录、迁移、备份、Agent、日志聚合/清理
两地执行节点：模型 API、各自内存状态、异步请求日志 → 同一 MySQL
```

## 前置条件

- 两地使用同一份 MySQL、同一版本的网关镜像。**必须保持既有 `JWT_SECRET` 相同**：供应商 Key 的加密密钥由它派生，更换会导致解密失败。
- 每个节点只运行一个执行进程。不要给同一个节点 ID 配多副本负载均衡或同时运行新旧版本；这会破坏内存计数和进程绑定的内部认证。
- 节点间使用合规加密专线/VPN，或具有可信证书的 HTTPS。HTTP peer origin 只允许环回、RFC1918 或 IPv6 ULA 地址；使用私网 IP 并不自动建立加密隧道。
- MySQL 只在受限私网开放。当前仍有请求路径访问 MySQL，配置缓存不等于数据库失联时的离线服务能力。
- peer 地址必须直达指定节点，而非 GeoDNS/CDN/两地混合 LB。代理必须关闭 SSE 缓冲，支持 WebSocket，并允许长连接。

## 配置

未设置任何 `GATEWAY_NODE_*` 变量时，保留单节点行为。设置 `GATEWAY_NODE_ID` 后，其余三项必须完整提供。

| 变量 | 含义 |
| --- | --- |
| `GATEWAY_NODE_ID` | 当前节点 ID，如 `node-a`、`node-b`；小写字母开头，仅字母、数字、连字符，最多 32 字符 |
| `GATEWAY_CONTROL_NODE_ID` | 唯一控制节点，两地均填 `node-a` |
| `GATEWAY_NODE_SECRET` | 两地相同的随机认证密钥，至少 32 字符；由 secret store 注入，不提交到仓库 |
| `GATEWAY_NODE_PEERS` | JSON：其他节点 ID → origin URL；不包含自身，无用户名、密码、路径、query 或 fragment |

控制节点 `.env.node-a.local` 的非敏感部分：

```dotenv
GATEWAY_NODE_ID=node-a
GATEWAY_CONTROL_NODE_ID=node-a
GATEWAY_NODE_PEERS={"node-b":"http://10.90.0.2:13030"}
GATEWAY_BIND_ADDRESS=10.90.0.1
GATEWAY_PORT=13030
```

另一地 `.env.node-b.local`：

```dotenv
GATEWAY_NODE_ID=node-b
GATEWAY_CONTROL_NODE_ID=node-a
GATEWAY_NODE_PEERS={"node-a":"http://10.90.0.1:13030"}
GATEWAY_BIND_ADDRESS=10.90.0.2
GATEWAY_PORT=13030
```

`10.90.0.1/2` 只是示例 VPN 地址。两份私有环境文件还需设置同一 `MYSQL_*`、`JWT_SECRET`、`GATEWAY_NODE_SECRET`，以及相同、固定版本的 `LLM_GATEWAY_IMAGE`。环境文件权限建议 `0600`；`.env.*.local` 已被 Git 忽略。

若使用公网域名作为 peer，必须填写 HTTPS origin，并将内部路径限制为两地服务的网络访问。不要关闭 TLS 证书验证。

## 启动顺序

`compose/dual-node.yml` 只部署网关，使用外部共享 MySQL，不在另一地创建第二份数据库。

1. 构建包含本次改造的镜像，固定相同版本；已有线上 `latest` 镜像不一定包含此功能。
2. **先启动控制节点**，完成数据库 v57/v58 migration：新增可空 `providers.owner_node`（v58 只负责把早期构建留下的 `owner_pop` 列改名，新库为空操作）。
3. 再启动另一地；非控制节点不会迁移，只校验 `owner_node` 列存在，缺失时启动失败。
4. 验证双向私网连通，再开放两地模型 API 接入。

```bash
# 控制节点主机
docker compose --env-file .env.node-a.local -f compose/dual-node.yml up -d
# 另一地主机
docker compose --env-file .env.node-b.local -f compose/dual-node.yml up -d
```

该 Compose 不挂载 Docker socket，也未默认启用 Agent worker。如果需要 Agent，仅在控制节点按 [Docker 部署指南](docker-deployment.md) 配置 worker 镜像、工作区和 socket；另一地不执行 Agent，也不对外提供 Agent 路由。

## 供应商归属

管理后台“提供商”表单新增 **Owner 节点**（下拉列出本节点可执行的节点 ID），API 对应 `ownerNode`：

- `node-a`：仅控制节点执行。
- `node-b`：仅另一地执行。
- 留空 / `null`：默认控制节点；原有供应商不会自动迁到另一地。
- 更新时不传 `ownerNode`：保持既有归属；显式 `null`：清除归属。
- 显式归属不会因关闭多节点模式而变成本地执行；未配置 owner 时会拒绝请求。

`ownerNode` 只能是当前节点可执行的节点（本节点或 `GATEWAY_NODE_PEERS` 中的 peer）：格式合法但未配置的归属不报错，只会让该供应商流量永久 503，所以写入时一律 `400 unknown_owner_node`（含单节点模式下的任何显式归属）。管理面板通过 `GET /api/admin/providers/node-options` 取得可用列表；两个节点下线或重命名后，启动时会把仍指向旧 ID 的供应商数量记到日志（不阻断启动）。

模型 API、供应商连通性测试、模型探测、模型列表导入都按 owner 执行。尚未保存的提供商导入模型时，也使用表单中的 Owner 节点。

变更已有供应商 owner 前，应先禁用该供应商、排空原节点请求，再修改并启用；已有流不能迁移，切换期间不能将两地内存计数视为连续值。

## 请求、计数和日志语义

- 入口做一次公开鉴权、Virtual Key RPM 计数和模型/供应商选择。内部 dispatch 不重新选模型、不再计 RPM，不携带供应商明文 Key。
- **Virtual Key RPM 按入口节点独立计算**：一个 Key 同时访问两地可获得两份额度，不是全局硬限制。计数重启归零。
- 实际执行 owner 维护供应商熔断及响应缓存。相同逻辑请求只有落到同一 owner 才能合并/命中同一内存缓存。
- 普通路由 affinity、游标和健康视图仍是本地状态；专家路由的持久会话绑定在 MySQL。此版本不广播远端熔断状态，入口可能先选到不健康目标再触发现有重试。
- 上游结果由执行节点沿用异步日志 buffer 写 MySQL；入口不重复写转发成功的使用量日志。`request_params_json` 附带 `ingress_node`、`execution_node`，远端 dispatch 还附带 `node_request_id`。关闭详细日志时不记录该关联 ID。
- Prompt 采样和响应缓存的早期命中均在入口完成：采样记录客户端原始请求（与单节点口径一致，包括智能路由改写前的模型名），owner 不重复采样；入口内存缓存只会命中本节点执行过的请求，转发给远端的请求由 owner 自己查缓存。
- 日志仍为内存缓冲：进程异常退出可能丢失未刷盘数据，**不构成可靠计费账本或全局余额扣减**。需要可靠计费时再增加持久化 outbox。
- 可信 Agent run 关联经签名 dispatch 传递，owner 重新签发本进程 loopback 标识；公开客户端伪造的 Agent 头不会被传递。
- `JEV_API_URL`、`COMPACT_BASE_URL` 等环境变量直连依赖不属于供应商 owner 配置。若要求统一出口，将其配置为本地网关中绑定真实供应商的专用模型端点，避免递归调用专家路由。

## 安全和失败行为

内部端点：

- `GET /api/internal/node/epoch`：返回本进程启动 epoch，无密钥，禁止缓存。
- `POST /api/internal/node/dispatch`：HMAC 绑定来源、目标、epoch、时间、nonce 和整个载荷。

签名接受时间窗口为 60 秒，两地需同步系统时钟。nonce 在内存去重；接收节点重启会改变 epoch，旧签名即便落在时间窗口内也不能重放。发送侧 epoch 最多缓存 5 秒，认证拒绝后清除缓存；**不会自动重放已经发送的业务请求**。

每进程最多保留 20,000 个未过期 nonce，达到上限时拒绝新内部请求而不淘汰有效防重放记录。越限返回 `503 node_dispatch_saturated`（带 `Retry-After`），故意不用 401：否则发送侧会误判对端重启、丢弃 epoch 缓存并在每次 dispatch 前重新握手，把过载放大成两节点握手风暴。应在接近此容量前评估吞吐，不要把此版本直接当成无限扩副本方案。

| 情况 | 结果 |
| --- | --- |
| owner 未配置 | 503 `owner_node_unconfigured` |
| owner / 链路不可用 | 503 `owner_node_unavailable`，不本地接管 |
| owner 归属已变 | 409 `owner_node_mismatch`，不回弹、不转发循环 |
| 内部签名、epoch 或重放校验失败 | 内部端点 401 `invalid_node_auth`；模型 API 转为 503 `peer_node_auth_failed`，不误报客户端 Key 失效 |
| 接收节点重放台账已满 | 内部端点 503 `node_dispatch_saturated`（容量而非认证；不会清除对端 epoch 缓存） |
| owner 熔断已打开、无可用 fallback | 503 `owner_circuit_open` |
| 非控制节点访问登录、管理或 Agent API | 503 `control_node_required` |
| 已经开始的 SSE / WebSocket 中断 | 结束/报错，不能透明迁移到另一节点 |

现有模型 fallback 可选择另一个供应商，包括另一个 owner；这不同于接管同一个供应商。普通智能路由重试窗口仍为 10 秒，跨节点链最多 8 跳。节点转发单次最长 10 分钟；客户端断开/取消会向 owner 传播中止。内部 envelope 上限 11 MiB，为公开 HTTP 的 10 MiB 请求预留元数据空间；超大 WebSocket 帧暂不支持跨节点，内部 WebSocket 单事件上限 10 MiB。提高这些上限前需验证内存和背压。

owner 刚重启时，使用旧 epoch 的那一次请求可能返回 503；下一次请求重新握手。此处刻意不自动重放业务请求，避免把未知执行结果变成重复调用。

另一地不提供管理 SPA；登录、管理与 Agent 始终访问控制节点。仅控制节点网关进程故障、且共享 MySQL 仍可达时，另一地本地供应商的模型 API 可以继续运行，控制节点归属供应商及管理/Agent 不可用。若控制节点主机或链路故障同时导致共享 MySQL 不可达，另一地也不保证离线服务；此版本不是数据库或控制面双活。

## 验收

1. 将一个测试供应商设为 `node-b`，分别从两地入口请求；供应商看到的出口均应为 `node-b`，HTTP 返回 `X-Gateway-Execution-Node: node-b`。
2. `ownerNode=null` 的供应商从任一入口请求，实际出口应为控制节点。
3. 检查共享 MySQL，同一成功转发不产生两份使用量记录，节点元数据正确。
4. 验证 OpenAI / Anthropic / Gemini 普通请求及 SSE、Responses WebSocket；流式首块不能等整段完成。
5. 取消请求，验证 owner 上游连接被中止；中途断链不能无缝接管。
6. 停掉 `node-b`，再请求其供应商；不得出现控制节点直连该供应商的流量。
7. owner 重启后旧内部请求不能重放；两地时钟偏差、错密钥应拒绝执行。
8. 检查另一地日志，确认未运行迁移、备份、Agent boot recovery 和日志聚合任务。

本地测试覆盖签名/重放、owner 拒绝、真实 HTTP/SSE 转发取消、WebSocket 内部事件桥及跨节点重试。真实跨地域延迟、出口 IP 和 VPN 故障效果仍需在部署环境执行上述验收。
