---
slug: extend-pii-protection-anthropic-responses
title: Extend PII protection to Anthropic and OpenAI Responses
status: verified
---

## Goal
将现有按虚拟 key 控制的 PII 保护能力扩展到 Anthropic `/v1/messages` 和 OpenAI Responses API，使这两条链路在开启保护时都能在请求前掩码敏感文本，并在响应返回客户端前恢复原值。

## Scope
- 启用 OpenAI Responses API 的 PII 保护接入，覆盖现有可达路径：流式 `/v1/responses` 和非流式 `/v1/responses/compact`；不扩展至变更路由行为
- 为 Anthropic 非流式与流式代理接入 PII 保护
- 扩展通用 PII 文本遍历逻辑以覆盖 Anthropic 请求/响应文本字段
- 补充针对 Responses 和 Anthropic 的后端验证测试

## Non-Goals
- 不修改数据库结构、虚拟 key 配置模型或前端开关 UI
- 不扩展到 Embeddings 或其他尚未启用 PII 的协议
- 不处理工具 schema、图片、二进制内容或结构化 JSON 参数里的任意深层 PII 扫描，除非它们已映射到现有明确文本字段
- 不重构整条代理架构或替换现有 PII 检测/掩码算法

## Constraints
- 继续复用 `packages/backend/src/services/pii-protection-service.ts`、`PiiStreamRestorer` 和现有 `virtualKey.pii_protection_enabled` 开关
- 保持 OpenAI Chat Completions 当前行为不变
- `/v1/responses` 路由行为保持不变（在已强制执行流式的地方仍然只支持流式）
- Responses 和 Anthropic 都需要覆盖 stream / non-stream 的实际返回路径
- 默认将 Anthropic `system`、`messages[].content`、响应 `content[].text` 以及流式 `text_delta` / `thinking_delta` 纳入保护范围
- 只在协议明确且虚拟 key 开启时启用，避免模糊推断

## Common Summary
- 目标是把"已有 PII 核心能力"接到更多协议，而不是新建一套保护系统
- OpenAI Responses 的流式底层已经支持 `__pii` 恢复，当前缺的是入口启用与非流式字段覆盖核实
- Anthropic 当前没有任何 PII 接线，需要在请求前、响应后、流式 SSE 三处补齐
- Anthropic 流式恢复是事件感知的，默认只针对承载文本的 delta（`content_block_delta.text` 和 `content_block_delta.thinking`）
- 通用字段遍历是共享合同：若这里覆盖不完整，Anthropic 和 Responses 都会漏保护或漏恢复
- 依赖顺序应先稳定共享文本字段/恢复规则，再接入具体协议链路，最后补测试
- 目前未发现需要用户重新确认的外部接口变更；行为变化仅发生在开启 PII 保护的 key 上

## Context Facts
- `packages/backend/src/routes/openai/proxy-handler.ts:28` 的 `shouldApplyPiiProtection()` 当前明确排除了 Responses、Embeddings 和非 OpenAI 协议
- `packages/backend/src/services/pii-protection-service.ts:91` 已支持 `input` 与 `instructions`，说明 Responses 请求字段已有部分基础
- `packages/backend/src/routes/openai/proxy-handler.ts:490` 和 `packages/backend/src/routes/openai/proxy-handler.ts:881` 当前只在 Chat Completions 路径创建 `__pii`
- `packages/backend/src/services/protocol-adapter.ts:535` 的 Responses 流处理已经会读取 `options.__pii` 并创建 `PiiStreamRestorer`
- `packages/backend/src/routes/anthropic/proxy-handler.ts:252` 与 `packages/backend/src/routes/anthropic/proxy-handler.ts:368` 当前直接发送原始请求体，没有 PII 预处理或恢复
- `packages/backend/src/types/anthropic.ts:55` 表明 Anthropic 请求还有 `system?: string | AnthropicContentBlock[]`
- `packages/backend/src/types/anthropic.ts:129` 表明 Anthropic 非流式响应核心文本位于 `content: AnthropicContentBlock[]`
- `packages/backend/src/services/pii-protection.test.ts` 目前只有通用和 OpenAI chat SSE 验证，没有 Anthropic/Responses 覆盖
- 标准 `/v1/responses` 非流式在当前业务中被拒绝，而 `/v1/responses/compact` 是相关的非流式响应路径

## Workstreams

### Workstream `shared-pii-field-coverage`
- workstream_id: `shared-pii-field-coverage`
- recommended_agent: `implementer`
- depends_on: none
- unblocks: `openai-responses-pii`, `anthropic-pii-integration`
- status: verified
- critic_review_required: yes
- acceptance_slice: 共享服务能正确识别以下目标文本字段：OpenAI Responses 请求/响应文本字段（`input`、`instructions` 及响应中的对应文本字段）、Anthropic `system` 字符串/文本块、`messages[].content`、非流式响应 `content[].text|thinking`；明确排除 `tool_result`、`input_json_delta`、`signature_delta` 除非后续证据要求否则
- review_evidence: 相关 service diff；针对新增字段的测试或最小可读示例覆盖
- plan:
  - 扩展 `packages/backend/src/services/pii-protection-service.ts` 的文本字段收集逻辑
  - 覆盖 Anthropic `system` 字符串/文本块、`content[].text`、必要的响应文本块字段
  - 保守处理 `tool_result` / `input_json_delta` 等非纯文本字段，避免误改结构化载荷
  - 如需支持 Anthropic 流事件恢复，补充可复用的文本恢复辅助方法或最小共享工具
- dependency_note: 下游分发需要合同审查完成后才能进行

### Workstream `openai-responses-pii`
- workstream_id: `openai-responses-pii`
- recommended_agent: `implementer`
- depends_on: `shared-pii-field-coverage`
- unblocks: none
- status: verified
- critic_review_required: no
- acceptance_slice: `/v1/responses` 流式和 `/v1/responses/compact` 非流式路径中，请求中的 `input` / `instructions` 可被掩码并在响应前恢复，关闭开关时行为不变
- review_evidence: `openai/proxy-handler.ts` diff；Responses 场景测试或高信号单元验证
- plan:
  - 调整 `shouldApplyPiiProtection()` 规则，使 Responses API 在开关开启且协议匹配时可启用
  - 在 OpenAI Responses 流式与 compact/non-stream 路径中注入 `maskRequestBodyInPlace()` 与 `__pii`
  - 复用已有 `restoreResponseBodyInPlace()` 做非流式恢复
  - 保持 Embeddings 仍不启用

### Workstream `anthropic-pii-integration`
- workstream_id: `anthropic-pii-integration`
- recommended_agent: `implementer`
- depends_on: `shared-pii-field-coverage`
- unblocks: none
- status: verified
- critic_review_required: yes
- acceptance_slice: `/v1/messages` 的请求和响应文本在开启保护时正确掩码/恢复，Anthropic 流式事件跨 chunk 时不会把 mask 残片泄露给客户端
- review_evidence: `anthropic/proxy-handler.ts`、必要的 `anthropic/http-client.ts` diff；Anthropic 非流式与流式恢复验证
- plan:
  - 在 `packages/backend/src/routes/anthropic/proxy-handler.ts` 和 `packages/backend/src/routes/anthropic/http-client.ts` 中按虚拟 key 开关启用请求掩码
  - 在 Anthropic 非流式响应返回前恢复原值
  - 在 Anthropic 流式 SSE 转发链路中恢复 `content_block_delta.text` 和 `content_block_delta.thinking` 等文本片段（默认仅针对这些文本承载 delta）
  - 确保日志记录与 token 统计仍走现有路径，不引入协议语义漂移

## Shared Contracts
- 启用条件合同：
  - `virtualKey.pii_protection_enabled === 1`
  - 仅在明确支持的协议/路径上启用
- 请求侧合同：
  - 掩码在“发往上游之前”完成
  - 原始值仅保存在 request-scoped `PiiProtectionContext`
- 响应侧合同：
  - 非流式在返回客户端前调用 `restoreResponseBodyInPlace()`
  - 流式通过 `PiiStreamRestorer` 恢复分片文本，并支持跨 chunk 边界
- 字段范围合同：
  - OpenAI Responses：`input`、`instructions` 及其响应中的明确文本字段
  - Anthropic：`system`、`messages[].content`、响应 `content[].text`、流事件文本 delta
- 安全边界合同：
  - 不在未确认为纯文本的结构化字段上做深度字符串替换
  - 不改变工具调用结构、usage、metadata 或协议控制字段

## Acceptance Criteria
- 开启 PII 保护的虚拟 key 调用 OpenAI Responses API 时，请求中的敏感值不会以明文发送到上游，客户端最终看到的是恢复后的原值（验证责任归属于 `openai-responses-pii` 工作流）
- 开启 PII 保护的虚拟 key 调用 Anthropic `/v1/messages` 时，请求中的敏感值不会以明文发送到上游，客户端最终看到的是恢复后的原值（验证责任归属于 `anthropic-pii-integration` 工作流）
- Responses 与 Anthropic 的流式输出在分块场景下不会泄露 mask 残片
- 关闭 PII 保护时，Responses 与 Anthropic 行为保持当前逻辑
- 现有 OpenAI Chat Completions PII 行为不回退
- 新增验证覆盖 Responses 与 Anthropic 的关键字段和恢复路径（由各自工作流负责）

## Review Plan
- 先做一次计划审视，确认"共享字段覆盖"应先于具体协议接入，避免两个链路各自实现不同字段规则
- 分发顺序：共享字段合同 -> OpenAI Responses -> Anthropic
- 实现后优先做代码审查式核对：
  - 是否复用了现有服务而非重复造逻辑
  - 是否引入了对 tool payload / 非文本字段的过度处理
  - 是否存在协议路径误判导致 Embeddings 等被意外启用
  - 是否保持流式与非流式恢复行为一致
- 若实现包含 Anthropic 新流式恢复工具或事件级改动，再做一次独立 review gate 检查合同漂移与 chunk 边界处理
- 最终复查确认修复：Responses stale `input` capture（在掩码后重新读取 body.input）与 Anthropic SSE flush tail-loss（flush 返回值正确写回 stream）

## Open Questions
- none
