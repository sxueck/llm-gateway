# 虚拟密钥额度自助查询 API（`GET /v1/quota`）

## 概述

持有虚拟密钥的客户端（IDE 插件、脚本、下游应用）经常需要在 429 之前知道自己还剩多少额度。`GET /v1/quota` 让虚拟密钥**查询自己的**模型每日/每周 token 额度摘要：每个**配置了额度的模型**返回日、周两个维度的上限 / 已用 / 剩余，以及额度重置时刻。

- **自助鉴权**：与 `/v1/chat/completions` 相同的虚拟密钥鉴权（`Authorization: Bearer <key>`，或 `x-api-key` / `x-goog-api-key` 头），不经过管理端 JWT。
- **只读、只看自己**：接口内部按鉴权密钥的 `virtual_key_id` 取数，其他密钥的额度不可见，也不能通过参数查询别的密钥。
- **口径与限流完全一致**：直接复用额度服务（`virtualKeyQuota`）的快照——网关时区自然日、周一为一周起点、按（密钥 × 客户端请求的模型名）计量；虚拟模型与它路由到的真实模型各自独立。

## 请求

```bash
curl -H "Authorization: Bearer sk-your-virtual-key" \
  https://your-gateway.example.com/v1/quota
```

无参数。`/quota` 与 `/v1/quota` 等价（与 `/v1/models` 的双路径约定一致）。

## 响应

```json
{
  "object": "virtual_key_quota_summary",
  "timezone": "Asia/Shanghai",
  "data": [
    {
      "object": "model_quota",
      "model": "gpt-x",
      "daily": {
        "limit_millions": 1,
        "limit_tokens": 1000000,
        "used_tokens": 250000,
        "remaining_tokens": 750000,
        "request_count": 3,
        "resets_at": "2026-03-04T16:00:00.000Z"
      },
      "weekly": {
        "limit_millions": 5,
        "limit_tokens": 5000000,
        "used_tokens": 550000,
        "remaining_tokens": 4450000,
        "request_count": 6,
        "resets_at": "2026-03-08T16:00:00.000Z"
      }
    },
    {
      "object": "model_quota",
      "model": "kimi-k2",
      "daily": null,
      "weekly": {
        "limit_millions": 2,
        "limit_tokens": 2000000,
        "used_tokens": 0,
        "remaining_tokens": 2000000,
        "request_count": 0,
        "resets_at": "2026-03-08T16:00:00.000Z"
      }
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| ---- | ---- |
| `timezone` | 网关时区（`system_config` 的 `gateway_timezone`，默认 `Asia/Shanghai`），日/周边界均按它计算 |
| `data[].model` | 模型名（`models.name`，即客户端请求时填的模型名） |
| `data[].daily` / `weekly` | 该维度的摘要；**未配置额度时为 `null`**（不会给出假的 0 上限） |
| `limit_millions` / `limit_tokens` | 配置的上限（单位 M / 折算后的 token 数） |
| `used_tokens` / `remaining_tokens` | 本周期已用 / 剩余 token；超限口径下剩余最小为 0 |
| `request_count` | 本周期请求次数 |
| `resets_at` | 本周期额度重置时刻（ISO 8601）：日额度=次日零点，周额度=下周一零点（网关时区） |

`data` 按当日已用量降序排列（按绝对用量排序，并非按接近上限的比例排序：已用 900k/上限 5M 的模型会排在已用 500k/上限 0.6M 的模型之前，但后者更先触顶）。

## 错误

沿用 OpenAI 错误信封 `{ "error": { message, type, param, code } }`：

| 状态码 | code | 说明 |
| ------ | ---- | ---- |
| 401 | `missing_authorization` / `invalid_api_key` | 未携带 / 无效虚拟密钥 |
| 403 | `api_key_disabled` | 虚拟密钥已禁用 |
| 500 | `quota_summary_error` | 额度**配置**表（`virtual_key_model_quotas`）读取失败——刻意**不**走限流路径的 fail-open 缓存，如实上报而不是返回空列表。注意：每日**用量**表（`virtual_key_model_daily_usage`）读取失败不走 500，与限流预检查同口径 fail-open，返回 200 且已用量仅含本进程计量（见下方口径备注） |

## 口径备注

- **用量读取 fail-open**：与限流预检查读取完全相同的内存格子，`virtual_key_model_daily_usage` 读取失败时不报 500，`used_tokens` / `request_count` 仅反映本进程计量（可能偏低）；额度配置表读取失败则如实 500。

- **已用量包含本进程在途计量**：已提交但尚未落库的 token 也计入 `used_tokens`，与预检查一致；多实例部署下其他实例的流量由同步周期（约 10s）合并。
- **软配额允许轻微超限**：预检查只看已结算用量，单次请求可越过上限一个自身请求的量，因此 `used_tokens` 可能大于 `limit_tokens`、`remaining_tokens` 被钳为 0。
- 管理端视角的同一份数据在 `GET /api/admin/virtual-keys/quotas?virtualKeyId=<id>&period=daily|weekly`（JWT 鉴权）。
