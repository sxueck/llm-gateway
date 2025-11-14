# Claude Prompt Caching 实现说明

## 概述

本项目已实现 Claude 的 Prompt Caching 机制，当模型启用 `supports_prompt_caching` 属性时，系统会自动在正确的位置注入 `cache_control` 字段。

## 功能特性

### 1. System 消息缓存
- 自动在 system 消息的最后一个 content 块上添加 `cache_control: { type: "ephemeral" }`
- 适用于包含长提示词、系统指令或上下文的场景

### 2. User 消息缓存
- 自动在最后 2-3 个 user 消息的最后一个 content 块上添加缓存断点
- 遵循 Anthropic 的最佳实践，最大化缓存命中率
- 支持字符串和数组格式的 content

### 3. Tools 定义缓存
- 自动在 tools 数组的最后一个工具定义上添加 `cache_control`
- 适用于使用大量工具定义的场景

## 启用方式

### 方法 1: 在模型属性中启用

在创建或编辑模型时，设置模型属性：

```json
{
  "supports_prompt_caching": true
}
```

### 方法 2: 使用预设模型

系统内置的 Claude 模型（如 `claude-sonnet-4-5-20250929`）默认已启用缓存支持。

## 实现位置

### 核心实现文件

1. **src/services/protocol-adapter.ts**
   - `convertToAnthropicFormat()`: 处理 system 消息和 user 消息的缓存注入
   - `addCacheControlToMessages()`: 在最后 2-3 个 user 消息上添加缓存断点
   - `addCacheControlToTools()`: 在最后一个工具定义上添加缓存断点
   - `anthropicChatCompletion()`: 处理非流式请求的缓存控制
   - `anthropicStreamChatCompletion()`: 处理流式请求的缓存控制

2. **src/routes/proxy/proxy-handler.ts**
   - 检测模型是否启用缓存支持
   - 记录缓存启用日志

## 缓存断点位置

根据 Anthropic 的最佳实践，缓存断点被放置在以下位置：

```json
{
  "system": [
    {
      "type": "text",
      "text": "System prompt content...",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Earlier user message...",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    },
    {
      "role": "assistant",
      "content": "Assistant response..."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Recent user message...",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    },
    {
      "role": "assistant",
      "content": "Another response..."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Latest user message...",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    }
  ],
  "tools": [
    {
      "name": "tool1",
      "description": "Tool 1 description"
    },
    {
      "name": "tool2",
      "description": "Tool 2 description",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}
```

## 日志输出

当缓存功能启用时，系统会输出以下日志：

### Proxy Handler 日志
```
[Proxy] Prompt Caching 已启用 | 模型: claude-sonnet-4-5 | 消息数: 10 | 工具数: 5
```

### Protocol Adapter 日志
```
[Protocol] 已在 system 消息上添加 cache_control
[Protocol] 已在最后 3 个 user 消息上添加 cache_control
[Protocol] 已在 5 个工具定义的最后一个工具上添加 cache_control
```

## 缓存收益

使用 Prompt Caching 可以显著降低成本：

- **缓存写入**: 首次请求时，缓存的内容按标准价格计费
- **缓存读取**: 后续请求命中缓存时，缓存部分按 10% 的价格计费
- **缓存有效期**: 5 分钟内的相同请求可以命中缓存

### 示例成本节省

假设一个请求包含：
- System prompt: 1000 tokens
- 历史对话: 5000 tokens
- 工具定义: 2000 tokens
- 新用户消息: 100 tokens

**首次请求**:
- 输入: 8100 tokens × $3/M = $0.0243

**后续请求（缓存命中）**:
- 缓存部分: 8000 tokens × $0.3/M = $0.0024
- 新内容: 100 tokens × $3/M = $0.0003
- 总计: $0.0027

**节省**: 90% 的输入成本

## 注意事项

1. **缓存适用性**:
   - 只有 Anthropic 协议的请求会应用缓存控制
   - OpenAI 协议的请求不受影响

2. **缓存断点数量**:
   - System 消息: 1 个断点
   - User 消息: 最多 3 个断点
   - Tools: 1 个断点
   - 总计最多 5 个断点（Claude API 限制）

3. **内容最小长度**:
   - Anthropic 要求缓存内容至少 1024 tokens
   - 小于此长度的内容不会被缓存

4. **缓存失效**:
   - 缓存会在 5 分钟后失效
   - 任何内容变化都会导致缓存失效

## 参考资料

- [Anthropic Prompt Caching Documentation](https://docs.anthropic.com/claude/docs/prompt-caching)
- [Roo-Code Implementation](https://github.com/RooCodeInc/Roo-Code)
