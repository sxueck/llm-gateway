# 环境变量

LLM Gateway 支持的全部环境变量。所有变量均为可选，除 **JWT_SECRET** 和 **MYSQL_PASSWORD** 外都有默认值。

## 配置来源与生效范围

LLM Gateway 的运行时配置只有两个真实来源：**环境变量**（部署层，进程启动时读取）和**数据库 `system_config` 表**（应用层，通过 Web UI 修改）。Web UI 的各个设置页只是 `system_config` 的编辑界面——UI 上不存在不落库的开关；反过来，环境变量也没有对应的 UI 入口。

### 两个来源的对比

|          | 环境变量                                                                   | `system_config`（Web UI）                                  |
| -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 修改入口 | `.env` 文件 / 进程环境（部署层）                                           | Web UI 各设置页（管理员登录）                              |
| 存储     | 无（多数在模块加载时读取一次）                                             | MySQL，持久化                                              |
| 生效方式 | **重启后端**                                                               | 多数**保存即生效**（保存后服务端重载，或下次请求读取新值） |
| 适用内容 | 部署基线：端口、数据库连接、出站代理、性能阈值、模型加载开关等基础设施参数 | 运行开关：注册、CORS、反爬、备份计划、S3、监控等业务配置   |

环境变量加载规则：

- 后端启动时通过 dotenv 加载 `.env`，按顺序查找第一个存在的位置：进程工作目录 → 仓库根目录 → `packages/backend/` 等候选路径。
- 已存在的系统环境变量优先于 `.env` 文件中的同名值。

### 优先级：仅两个配置项接受双来源

只有下表中的配置项同时接受两种来源，此时 **`system_config`（Web UI）覆盖环境变量**——环境变量仅在对应键从未落库时充当默认值：

| 配置项         | 环境变量（初始默认）                                                                          | `system_config` 键（覆盖）                                                               | 修改入口                          |
| -------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| 公网地址       | `PUBLIC_URL`                                                                                  | `public_url`                                                                             | Web UI 系统设置，保存即生效       |
| 备份计划与保留 | `BACKUP_SCHEDULE_CRON` / `BACKUP_RETENTION_DAYS` / `BACKUP_MAX_COUNT` / `BACKUP_INCLUDE_LOGS` | `backup_schedule` / `backup_retention_days` / `backup_max_count` / `backup_include_logs` | Web UI 备份管理，保存即重载调度器 |

除这两项外，本文档列出的其余环境变量都是**唯一配置入口**：没有 UI 开关，也没有同名 `system_config` 键，修改后必须重启后端。

### `system_config` 键 → Web UI 页面速查

以下运行开关不通过环境变量配置，只能在 Web UI 对应页面修改，保存即生效：

| Web UI 页面  | `system_config` 键                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统设置     | `allow_registration`（允许注册）、`cors_enabled`、`public_url`、`litellm_compat_enabled`（LiteLLM 兼容）、`dashboard_hide_request_source_card`、`traffic_analysis_region`、`reasoning_effort_model_suffixes`（推理力度模型后缀） |
| 安全设置     | `anti_bot_*`（反爬系列）、`forward_client_user_agent`（转发客户端 UA）、`skip_upstream_ssl_verify`（跳过上游 SSL 校验）                                                                                                          |
| 备份管理     | `backup_schedule`、`backup_retention_days`、`backup_max_count`、`backup_include_logs`、`s3_endpoint` / `s3_bucket_name` / `s3_region` / `s3_access_key_id` / `s3_secret_access_key` / `s3_force_path_style`                      |
| 健康监控设置 | `health_monitoring_enabled`、`persistent_monitoring_enabled`、`monitoring_virtual_key_id`                                                                                                                                        |
| 开发者设置   | `developer_debug_enabled`、`developer_debug_expires_at`                                                                                                                                                                          |
| 专家路由     | `expert_routing_preview_width`                                                                                                                                                                                                   |

### 如何判断一个配置项的修改入口

1. 出现在本文档下方环境变量总表中（`PUBLIC_URL`、备份四项除外）→ 改 `.env` 并重启后端。
2. 要改公网地址或备份计划/保留策略 → 直接用 Web UI（优先级高于 env，立即生效；env 只在从未落库时生效）。
3. 其余一切运行开关（注册、CORS、反爬、S3、监控、调试等）→ 按上表到对应 Web UI 页面。
4. `.env` 中的 `S3_*` 变量**不被任何代码读取**，属于无效配置；S3 只能在 Web UI 备份管理页配置。

## 必填变量

| 变量             | 说明                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`     | JWT 签名密钥，**至少 32 个字符**。同时用于 Provider API 密钥加密与备份文件加密——修改后已保存的 Provider 密钥将无法解密（需重新录入），历史备份也无法恢复。 |
| `MYSQL_PASSWORD` | MySQL 密码（无默认值）。                                                                                                                                   |

## 基础配置

| 变量                             | 默认值                    | 说明                                                                                                                             |
| -------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                           | `3000`                    | 后端监听端口。                                                                                                                   |
| `NODE_ENV`                       | `development`             | `development` / `production` / `test`。Docker 镜像默认设为 `production`。                                                        |
| `LOG_LEVEL`                      | `info`                    | 日志级别。                                                                                                                       |
| `PUBLIC_URL`                     | `http://localhost:{PORT}` | LLM Gateway 公网地址。**双来源**：Web UI 系统设置（`system_config` 键 `public_url`）优先；此项仅在从未通过 UI 设置时作为默认值。 |
| `API_REQUEST_LOG_RETENTION_DAYS` | `14`                      | API 请求日志保留天数。                                                                                                           |

## MySQL 数据库

| 变量                     | 默认值        | 说明         |
| ------------------------ | ------------- | ------------ |
| `MYSQL_HOST`             | `localhost`   | 主机。       |
| `MYSQL_PORT`             | `3306`        | 端口。       |
| `MYSQL_USER`             | `root`        | 用户名。     |
| `MYSQL_DATABASE`         | `llm_gateway` | 数据库名。   |
| `MYSQL_CONNECTION_LIMIT` | `30`          | 连接池上限。 |

## 上游网络代理

标准代理变量，支持大写和小写变体，作用于网关到上游 LLM 提供商的出站请求：

| 变量                          | 默认值 | 说明                                                          |
| ----------------------------- | ------ | ------------------------------------------------------------- |
| `HTTPS_PROXY`                 | 未设置 | HTTPS 请求代理；未设置时 HTTPS 回退到 `HTTP_PROXY`。          |
| `HTTP_PROXY`                  | 未设置 | HTTP 请求代理。                                               |
| `NO_PROXY`                    | 空     | 例外主机列表（逗号分隔，支持 `*` 通配），命中的地址不走代理。 |
| `HTTP_KEEP_ALIVE_MAX_SOCKETS` | `64`   | 上游 HTTP keep-alive agent 的最大 socket 数。                 |

## 意图路由 / 专家路由

| 变量                           | 默认值 | 说明                                                                                                                                                                                                                         |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTENT_ROUTER_API_URL`        | 未设置 | 外置 Intent Router API 的绝对 HTTP(S) 地址；可使用部署服务名，例如 `http://intent-router:8000`。网关请求其 `/v1/intent`。未设置或服务异常时，专家路由继续走 LLM 二次分类 / fallback，网关 `/v1/intent/classify` 返回 `503`。 |
| `INTENT_ROUTER_API_KEY`        | 未设置 | 可选的外置服务 Bearer token，对应服务端的 `INTENT_ROUTER_API_KEYS`。                                                                                                                                                         |
| `INTENT_ROUTER_API_TIMEOUT_MS` | `5000` | 网关调用外置 Intent Router API 的超时（毫秒）。                                                                                                                                                                              |

## 消息压缩与上下文规范化

| 变量                                         | 默认值  | 说明                                             |
| -------------------------------------------- | ------- | ------------------------------------------------ |
| `KEEP_RECENT_MESSAGES`                       | `5`     | 压缩历史消息时保留不压缩的最新消息条数。         |
| `MIN_TEXT_LENGTH`                            | `200`   | 文本块达到该长度才参与压缩。                     |
| `MIN_CODE_LENGTH`                            | `100`   | 代码块达到该长度才参与压缩。                     |
| `MESSAGE_COMPRESSION_MIN_TOKENS`             | `2048`  | 请求估算 token 数达到该阈值才触发消息压缩。      |
| `CONTEXT_NORMALIZATION_IDLE_TTL_SECONDS`     | `1800`  | 上下文规范化绑定的空闲 TTL（同指纹命中即续期）。 |
| `CONTEXT_NORMALIZATION_ABSOLUTE_TTL_SECONDS` | `86400` | 上下文规范化绑定的绝对生命周期上限。             |
| `CONTEXT_NORMALIZATION_EVENT_RETENTION_DAYS` | `30`    | 上下文规范化事件保留天数（过期清理）。           |

## PII 防护（性能调优）

超过上限的字段/匹配直接跳过检测，宁可漏检也不拖慢请求。

| 变量                        | 默认值   | 说明                                 |
| --------------------------- | -------- | ------------------------------------ |
| `PII_MAX_FIELD_SCAN_LENGTH` | `50000`  | 单个文本字段最大扫描长度（字符）。   |
| `PII_MAX_MATCHES_PER_FIELD` | `2000`   | 单个字段最多收集的匹配候选数。       |
| `PII_MAX_TOTAL_SCAN_CHARS`  | `500000` | 单次请求所有字段累计最大扫描字符数。 |

## 图片压缩

| 变量                                | 默认值               | 说明                                        |
| ----------------------------------- | -------------------- | ------------------------------------------- |
| `IMAGE_COMPRESSION_MAX_EDGE_PX`     | `768`                | 压缩后最长边像素（有效范围 64–4096）。      |
| `IMAGE_COMPRESSION_CACHE_MAX_BYTES` | `104857600`（100MB） | 压缩结果 LRU 缓存上限（有效范围 1MB–2GB）。 |

## 负载均衡与会话粘性

| 变量                              | 默认值              | 说明                                           |
| --------------------------------- | ------------------- | ---------------------------------------------- |
| `MAX_AFFINITY_STATE_ENTRIES`      | `20000`             | 内存中 affinity 状态条目上限，超出按最旧淘汰。 |
| `MAX_LOAD_BALANCE_CURSOR_ENTRIES` | `10000`             | 负载均衡游标 / half-open probe 状态条目上限。  |
| `EXPLICIT_AFFINITY_IDLE_TTL_MS`   | `3600000`（1 小时） | 显式 session 绑定的空闲过期时间（毫秒）。      |

## 流式响应重试

| 变量                                      | 默认值  | 说明                                          |
| ----------------------------------------- | ------- | --------------------------------------------- |
| `ANTHROPIC_STREAM_EMPTY_RETRY_LIMIT`      | `1`     | Anthropic 流式空响应重试次数上限。            |
| `RESPONSES_STREAM_EMPTY_RETRY_LIMIT`      | `1`     | OpenAI Responses API 流式空响应重试次数上限。 |
| `GEMINI_STREAM_EMPTY_RETRY_LIMIT`         | `1`     | Gemini 流式空响应重试次数上限。               |
| `GEMINI_EARLY_EMPTY_DETECTION_TIMEOUT_MS` | `10000` | Gemini 流提前判空超时（毫秒）。               |

## 日志写入缓冲

| 变量                                    | 默认值 | 说明                           |
| --------------------------------------- | ------ | ------------------------------ |
| `API_REQUEST_BUFFER_MAX_RETRY_ATTEMPTS` | `5`    | 批量写库失败时的最大重试次数。 |

## 备份

| 变量                    | 默认值                         | 说明                                                                                                                             |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_SCHEDULE_CRON`  | `0 2 * * 2`（每周二凌晨 2 点） | 定时备份 Cron 表达式。**双来源**：Web UI 备份管理页（`backup_schedule`）优先且保存即生效；此项仅在从未通过 UI 设置时作为默认值。 |
| `BACKUP_RETENTION_DAYS` | `30`                           | 备份保留天数。同上，Web UI（`backup_retention_days`）优先。                                                                      |
| `BACKUP_MAX_COUNT`      | `50`                           | 最大备份份数。同上，Web UI（`backup_max_count`）优先。                                                                           |
| `BACKUP_INCLUDE_LOGS`   | `false`                        | 设为 `true` 时备份数据包含日志表。同上，Web UI（`backup_include_logs`）优先。                                                    |
| `BACKUP_TEMP_DIR`       | `<工作目录>/temp/backups`      | 备份临时目录。                                                                                                                   |

> **注意**：S3 存储配置**不通过环境变量读取**，唯一入口是 Web UI 备份管理页（值存入数据库 `system_config` 表）。`.env` 中的 `S3_*` 条目不被任何代码读取，属于无效配置（见「配置来源与生效范围」）。

## IP 防护

| 变量                   | 默认值                                                              | 说明                             |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------- |
| `GEO_IP_ENABLED`       | 启用                                                                | 设为 `false` 时关闭 GeoIP 解析。 |
| `THREAT_IP_SOURCE_URL` | `https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt` | 威胁 IP 黑名单拉取地址。         |
