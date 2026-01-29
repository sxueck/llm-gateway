# Anthropic API 代理使用说明

## 概述

LLM Gateway 现已支持 Anthropic 协议的 API 代理功能。通过 `/v1/messages` 端点，您可以使用 Anthropic 原生格式的请求与上游 Anthropic 兼容的服务进行交互。

## 端点

- **POST** `/v1/messages` - Anthropic Messages API

## 请求格式

### 非流式请求示例

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_VIRTUAL_KEY" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "Hello, Claude!"
      }
    ]
  }'
```

### 流式请求示例

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_VIRTUAL_KEY" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "Tell me a story"
      }
    ]
  }'
```

## 请求参数

### 必需参数

- `model` (string): 模型名称
- `messages` (array): 消息数组
- `max_tokens` (integer): 最大生成 token 数

### 可选参数

- `system` (string | array): 系统提示词
- `temperature` (number): 温度参数 (0-1)
- `top_p` (number): Top-p 采样参数
- `top_k` (integer): Top-k 采样参数
- `stop_sequences` (array): 停止序列
- `stream` (boolean): 是否启用流式响应
- `service_tier` (string): 服务档位（如 `auto` / `standard_only`，不同上游可能扩展）
- `metadata` (object): 元数据
- `betas` (array): Beta 功能标识列表（会转为 `anthropic-beta`，兼容上游差异）
- `thinking` (object): 扩展思考配置（例如 `{ "type": "enabled", "budget_tokens": 2048 }`）
- `tools` (array): 工具定义
- `tool_choice` (object): 工具选择策略

## 响应格式

### 非流式响应

```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Hello! How can I help you today?"
    }
  ],
  "model": "claude-3-5-sonnet-20241022",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20
  }
}
```

### 流式响应

流式响应使用 Server-Sent Events (SSE) 格式：

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01XFDUDYJgAACzvnptvVoYEL","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":10,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}

event: message_stop
data: {"type":"message_stop"}
```

## 错误处理

错误响应遵循 Anthropic 标准格式：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Missing required field: model"
  }
}
```

### 错误类型

- `invalid_request_error`: 请求参数错误
- `authentication_error`: 认证失败
- `permission_error`: 权限不足
- `not_found_error`: 资源不存在
- `rate_limit_error`: 速率限制
- `api_error`: API 错误
- `overloaded_error`: 服务过载

## 配置要求

1. **提供商配置**: 上游提供商必须配置为 Anthropic 协议
2. **虚拟密钥**: 需要有效的虚拟密钥进行认证
3. **模型映射**: 确保虚拟密钥关联的模型已正确配置

## 功能特性

- ✅ 支持流式和非流式响应
- ✅ 支持工具调用 (Function Calling)
- ✅ 支持系统提示词
- ✅ 支持请求日志记录
- ✅ 支持虚拟模型映射
- ✅ 支持负载均衡和故障转移
- ✅ 支持熔断器保护
- ✅ 返回 Anthropic 兼容的错误格式

## 限制

- 仅支持 Anthropic 协议的上游提供商
- 不支持 OpenAI 到 Anthropic 的协议转换（请使用 `/v1/chat/completions` 端点）
