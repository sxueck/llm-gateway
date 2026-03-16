# Runbook: extend-pii-protection-anthropic-responses

## Spec
- spec_path: `.agents/specs/extend-pii-protection-anthropic-responses.md`
- spec_status: `approved`

## Shared Execution Status
- overall_status: `verified_complete`
- current_focus: `全部实现与复查已完成`
- latest_checkpoint: `最终复查通过：Responses 与 Anthropic 的 PII 扩展已完成，关键回归缺陷已修复`
- updated_at: `2026-03-14`

## Dependency State
- `shared-pii-field-coverage`: completed (sequence: first)
- `openai-responses-pii`: completed (sequence: second)
- `anthropic-pii-integration`: completed (sequence: third)

## Workstream Assignments
### `shared-pii-field-coverage`
- assigned_agent: `implementer`
- status: `completed`
- attempts: 2
- retry_history: 
  - Attempt 1: Initial implementation covering Anthropic fields and OpenAI Responses request fields
  - Attempt 2 (revision): Added OpenAI Responses non-stream response shape coverage
- files_touched:
  - `packages/backend/src/services/pii-protection-service.ts`
  - `packages/backend/src/services/pii-protection.test.ts`
- checks_expected: code review plus targeted lightweight validation if cheap
- checks_run:
  - Type check (all packages): passed
  - PII protection tests: 12/12 passed (added 2 new tests for Responses response shapes)
  - Field coverage verified:
    - Anthropic system (string and blocks): ✓
    - Anthropic messages[].content: ✓
    - Anthropic response content[].text|thinking: ✓
    - OpenAI Responses input (string and array): ✓
    - OpenAI Responses instructions: ✓
    - OpenAI Responses non-stream response output_text: ✓
    - OpenAI Responses non-stream response output[].text: ✓
    - OpenAI Responses non-stream response output[].content[].text (type 'text'|'output_text'): ✓
    - Exclusion of tool_result: ✓
    - Exclusion of structured blocks (tool_call) in Responses: ✓
- open_risks: |
    共享合同已完成，下游工作流可开始；
    明确排除：`tool_result`、`input_json_delta`、`signature_delta`、非 text/output_text 类型 content 块；
    contract_ready for downstream dispatch
- boundary_notes: |
    **OpenAI Responses request coverage boundary:** 共享层目前仅覆盖 `input` (作为 string/string-array) 和 `instructions`；
    不包含对任意结构化 `input` 项的深度扫描。
    **Stream delta exclusions:** `input_json_delta` 和 `signature_delta` 不在共享服务范围内，如需处理仅在 Anthropic stream-specific 工作流中处理。

### `openai-responses-pii`
- assigned_agent: `implementer`
- status: `completed`
- attempts: 3
- retry_history:
  - Attempt 1: Implementation completed but failed review due to stale pre-mask `input` variable (code captured `input` before masking, then used stale value for upstream request)
  - Attempt 2: Pending fix for stale `input` capture bug in both stream and compact paths
  - Attempt 3: Moved `input` reads to after `maskRequestBodyInPlace()` in both Responses paths and added focused validation for stale capture regression
- files_touched:
  - `packages/backend/src/routes/openai/proxy-handler.ts`
- checks_expected: code review plus targeted lightweight validation covering stream `/v1/responses` and non-stream `/v1/responses/compact` scenarios
- checks_run:
  - Type check (backend): passed
  - PII protection tests: 12/12 passed
  - Type check (backend, post-input-fix): passed
  - PII protection tests: 15/15 passed (added 1 focused stale-input regression validation)
  - Field coverage verified:
    - Responses stream PII masking with `__pii` context: ✓
    - Responses compact non-stream PII masking: ✓
    - Responses compact response restoration: ✓
    - Embeddings still excluded: ✓
    - Chat completions behavior preserved: ✓
    - Responses stream uses masked `request.body.input` after masking: ✓
    - Responses compact uses masked `request.body.input` after masking: ✓
- open_risks: |
    Validation remains repository-local rather than a live upstream integration run;
    request-side stale `input` capture bug is cleared in code and focused test coverage

### `anthropic-pii-integration`
- assigned_agent: `implementer`
- status: `completed`
- attempts: 3
- retry_history:
  - Attempt 1: Implementation completed but failed final review due to flush tail-loss bug (flush return values not written back to stream)
  - Attempt 2: Pending fix for flush tail-loss and unsafe key range issues
  - Attempt 3: Fixed flush write-back and dynamic key tracking; added consume/wire-up integration coverage
- files_touched:
  - `packages/backend/src/routes/anthropic/proxy-handler.ts`
  - `packages/backend/src/routes/anthropic/http-client.ts`
  - `packages/backend/src/services/pii-protection.test.ts`
- checks_expected: code review plus targeted lightweight validation if cheap
- checks_run:
  - Type check (backend): passed
  - PII protection tests: 13/13 passed (added 1 new test for Anthropic stream restorer)
  - Type check (backend, post-fix): passed
  - PII protection tests: 14/14 passed (added consumeAnthropicStreamAttempt integration coverage for flush write-back)
  - Field coverage verified:
    - Anthropic request masking (system, messages[].content): ✓
    - Anthropic non-stream response restoration: ✓
    - Anthropic stream text_delta restoration: ✓
    - Anthropic stream thinking_delta restoration: ✓
    - input_json_delta NOT mutated: ✓
    - signature_delta NOT mutated: ✓
- open_risks: |
    Anthropic stream restoration now flushes only dynamically used `text_delta` / `thinking_delta` keys;
    synthetic flush events are emitted at safe block/message boundaries to preserve tail text without mutating `input_json_delta` or `signature_delta`;
    coverage remains lightweight and focused on the consume/wire-up path rather than end-to-end upstream SDK transport

## Current Wave
- `shared-pii-field-coverage` verified
- `openai-responses-pii` verified
- `anthropic-pii-integration` verified
- 全部工作流已完成并复查通过，所有 PII 保护扩展已就绪

## Attempt History
- 2026-03-14: spec artifact created successfully
- 2026-03-14: critique completed and sequencing tightened
- 2026-03-14: shared-pii-field-coverage implementation completed (attempt 1)
  - Extended `collectTextRefs()` in pii-protection-service.ts to cover:
    - Anthropic `system` field (string and content blocks)
    - Anthropic response `content` array with `text` and `thinking` block types
    - Added type-safe filtering to only process `type: 'text'` blocks in message content
  - Added comprehensive tests for new field coverage
  - All tests passing (10/10)
  - Type check passed for all packages
- 2026-03-14: orchestrator spot review found missing OpenAI Responses non-stream response coverage
- 2026-03-14: shared-pii-field-coverage revision completed (attempt 2)
  - Extended `collectTextRefs()` to cover OpenAI Responses non-stream response shapes:
    - Top-level `output_text` field
    - `output[].text` field in array items
    - `output[].content[]` blocks with type `'text'` or `'output_text'` and `text` field
  - Added `testOpenAIResponsesNonStreamResponseCoverage()` test verifying all three shapes
  - All tests passing (12/12)
  - Type check passed for all packages
- 2026-03-14: shared-contract review passed, downstream dispatch approved
- 2026-03-14: openai-responses-pii implementation completed
  - Updated `shouldApplyPiiProtection()` to allow Responses API (kept Embeddings excluded)
  - Added PII masking in `handleStreamRequest()` for Responses API with `__pii` context
  - Added PII masking and restoration in `handleNonStreamRequest()` for Responses compact
  - Type check passed
  - All PII protection tests passed (12/12)
- 2026-03-14: anthropic-pii-integration implementation completed
  - Added PII imports (`maskRequestBodyInPlace`, `restoreResponseBodyInPlace`) to `proxy-handler.ts`
  - Added request masking in `handleAnthropicNonStreamRequest()` before upstream call
  - Added response restoration in `handleAnthropicNonStreamRequest()` before replying to client
  - Added request masking in `handleAnthropicStreamRequest()` before upstream call
  - Updated `makeAnthropicStreamRequest()` signature to accept optional `piiCtx` parameter
  - Added `PiiStreamRestorer` integration in `consumeAnthropicStreamAttempt()` for stream restoration
  - Stream restoration targets only `text_delta` and `thinking_delta` (NOT `input_json_delta` or `signature_delta`)
  - Added `testAnthropicStreamRestorer()` test for stream restoration verification
  - Type check passed
  - All PII protection tests passed (13/13)
- 2026-03-14: anthropic-pii-integration review failed - verifier findings:
  - flush return values not written back (pending tail text dropped)
  - fixed 0..31 key range unsafe (should use dynamic range from mask context)
  - existing test only covers restorer primitive, not consume/wire-up integration
- 2026-03-14: anthropic-pii-integration fix completed
  - Reworked Anthropic SSE restoration to track only keys actually used during stream consumption
  - Added event-aware flush write-back that emits restored tail text before `content_block_stop`, before non-text deltas on the same block, and at final message/end-of-stream boundaries
  - Kept exclusions unchanged for `input_json_delta` and `signature_delta`
  - Exported `consumeAnthropicStreamAttempt()` for targeted integration verification
  - Added `testAnthropicStreamFlushIntegration()` to validate real SSE wire-up, flush write-back, and non-text delta preservation
  - Backend type check passed
  - All PII protection tests passed (14/14)
- 2026-03-14: openai-responses-pii review failed - verifier findings:
  - Stale `input` variable bug: code captures `input` before `maskRequestBodyInPlace()` is called, then uses the stale (unmasked) value when sending upstream
  - Affects both stream path (`handleStreamRequest`) and compact non-stream path (`handleNonStreamRequest`)
  - When `input` is a string, the masked value is never used; the original unmasked string goes to upstream
  - Fix required: read `input` from the body object AFTER masking is applied, or use the masked body directly
- 2026-03-14: openai-responses-pii stale-input fix completed
  - Updated `packages/backend/src/routes/openai/proxy-handler.ts` so both Responses stream and compact paths read `input` only after `maskRequestBodyInPlace()` mutates `request.body`
  - Preserved existing route behavior: `/v1/responses` remains streaming-only and Embeddings remain excluded from PII handling
  - Added focused validation in `packages/backend/src/services/pii-protection.test.ts` to prove stale pre-mask captures remain plaintext while refreshed reads from `request.body` use masked data
  - Backend type check passed
  - All PII protection tests passed (15/15)
- 2026-03-14: final verifier pass - spec and runbook updated to verified status, all workstreams confirmed complete

## Files Touched
- `.agents/specs/extend-pii-protection-anthropic-responses.md`
- `.agents/runs/extend-pii-protection-anthropic-responses.md`
- `packages/backend/src/services/pii-protection-service.ts` (shared contract)
- `packages/backend/src/services/pii-protection.test.ts` (shared contract tests + anthropic stream test)
- `packages/backend/src/routes/openai/proxy-handler.ts` (openai-responses-pii workstream)
- `packages/backend/src/routes/anthropic/proxy-handler.ts` (anthropic-pii-integration workstream)
- `packages/backend/src/routes/anthropic/http-client.ts` (anthropic-pii-integration workstream)

## Checks Run
- Type check (all packages): passed
- PII protection tests: 12/12 passed (added 2 new tests for Responses response shapes)
- Type check (backend after openai-responses-pii): passed
- PII protection tests (after openai-responses-pii): 12/12 passed
- Type check (backend after anthropic-pii-integration): passed
- PII protection tests (after anthropic-pii-integration): 13/13 passed (added 1 new test for Anthropic stream restorer)
- Type check (backend after openai-responses-pii stale-input fix): passed
- PII protection tests (after openai-responses-pii stale-input fix): 15/15 passed (added 1 focused stale-input regression validation)

## Open Risks
- 验证范围仅限于仓库本地测试，未经过线上上游 Anthropic 或 OpenAI Responses 真实环境端到端验证
- 若未来新增文本字段需要 PII 保护，需显式扩展共享合同中的字段覆盖范围

## Blocked Items
- none
