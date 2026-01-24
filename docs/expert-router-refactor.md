# Expert Router 重构方案（面向原生工具调用 + 多轮对话）

本文把当前“专家路由/意图识别”能力（后端 `expertRouter`）重构为一个可插拔的 **Routing Orchestrator**：用 **L1 语义路由（向量，快）+ L2 规则/状态修正（稳）+ L3 小模型/LLM 兜底（准）** 的分层方式，替代单点的“每次都走 LLM classify”。

参考来源：
- 既有 8 类编程场景 taxonomy（见 `docs/prompts/category/`）与网关语义路由讨论记录
- `semantic-router` 的 `Route / Router Layer / Hybrid / Threshold Optimization` 思路

当前 8 类意图定义（边界清晰、逻辑明确）：
- `docs/prompts/category/intent_debug.md`
- `docs/prompts/category/intent_explain.md`
- `docs/prompts/category/intent_feature.md`
- `docs/prompts/category/intent_plan.md`
- `docs/prompts/category/intent_refactor.md`
- `docs/prompts/category/intent_review.md`
- `docs/prompts/category/intent_setup.md`
- `docs/prompts/category/intent_test.md`

## 1. 现状（需要解耦/增强的点）

当前路由链路集中在：
- `packages/backend/src/services/expert-router.ts`：拉取配置 → LLM 分类（JSON {type}）→ 选择专家 → resolve 到 provider/model → 记录日志/降级
- `packages/backend/src/routes/proxy/routing.ts`：在 `resolveExpertRouting` 中调用 `expertRouter.route(...)`
- `packages/backend/src/types/index.ts`：`ExpertRoutingConfig`（classifier/experts/fallback）

现状的结构性问题：
- **强依赖一次 LLM classify**：对多轮/工具调用场景，既慢/贵，也容易抖动；分类失败或边界模糊时缺少“快速、可解释的中间层”。
- **耦合过重**：对话抽取、去噪、分类请求构造、专家匹配、模型解析、日志与降级都在一个类内，后续引入向量路由/阈值训练/意图粘滞会变复杂。
- **工具调用未作为一等信号**：原生工具调用（tool call/result）本身就是意图判别强特征，但目前更多靠 prompt/LLM 推断。

## 2. 目标形态：Routing Orchestrator（三层决策）

保持对外入口兼容：仍由 `ExpertRouter.route(request, expertRoutingId, context)` 提供能力，但内部拆分为流水线。

### 2.1 Preprocess：构建 RoutingSignal（可测、纯函数）

输入：`ProxyRequest`（支持 Chat Completions / Responses API，兼容你们当前逻辑）。

输出：`RoutingSignal`（示例字段）
- `intentText`：用于语义路由的“意图文本”（尽量剥离大段代码/JSON/tool 输出噪声）
- `historyHint`：上一轮意图/最近 N 轮关键摘要（可先用规则拼接，不要求 LLM）
- `toolSignals`：最近一次工具调用/结果、工具名、是否错误、状态码等
- `hardHints`：slash 命令（如 `/review`）、stacktrace、diff、明显的测试/重构关键词等

### 2.2 RouteDecision：多策略编排（L1/L2/L3）

L1：**Semantic Router（向量路由，毫秒级）**
- 维护 `routes = [{name, utterances[]}]`，name 直接对齐这 8 类：`debug/explain/feature/plan/refactor/review/setup/test`
- 支持 `threshold`（最低可信分）与 `margin`（Top1-Top2 差距）
- 仅在“可信”时直接产出决策，否则进入 L2/L3

L2：**Heuristic & State（规则 + 意图粘滞/状态机）**
- 意图粘滞：当前句子缺乏强信号时继承上一轮 intent（多轮对话典型）
- tool 信号强制改写：
  - tool result/日志中出现 `Exception|Traceback|status>=400` → 强制 `debug`
  - 用户显式 `/review` `/refactor` → 强制对应意图
- 规则只做“高置信修正”，避免与 L1/L3 相互打架

L3：**LLM Judge（现有 classify 逻辑兜底）**
- 仅当 L1 低于阈值或 margin 太小，或 L2 判定冲突/不确定时触发
- 复用现有分类器协议：prompt 产出 JSON `{"type": "..."}`；其中 `type` 严格限定为上述 8 类

### 2.3 Resolve & Policy：专家解析 + 工具策略

Resolve：仍然是 `category -> ExpertTarget -> provider/model`，但把“匹配/默认/权重”抽离成独立模块。

Policy（新增）：**ToolPolicy**
- 路由结果不仅是“选哪个专家”，还需要产出“本轮允许的 tools 白名单/限额/风险控制”。
- 示例：
  - `review`：只读工具（检索/读取），禁用写文件/执行命令
  - `debug`：允许执行/日志读取，但对破坏性命令加拦截
  - `plan`：默认不调用工具或仅轻量检索，避免无效消耗

## 3. 配置改造：在 ExpertRoutingConfig 上做可选增强（兼容旧配置）

保留现有：`classifier / experts / fallback`。

新增可选字段（不影响老配置落库与运行）：
- `routing.mode`: `llm | semantic | hybrid`（默认 `llm`，便于灰度）
- `routing.semantic`：
  - `routes`: `{ category, utterances[] }[]`
  - `threshold`, `margin`, `maxHistoryTurns`
  - `denoise` 策略开关（是否剥离代码块/JSON）
  - `encoder`: `local | remote`（优先 local 才能做到低延迟）
- `routing.policy`：意图/类别到 tool policy 的映射

## 4. 代码结构拆分建议（可测试、可演进）

将 `packages/backend/src/services/expert-router.ts` 拆分为目录，但保留对外 `expertRouter` 单例不变：

- `packages/backend/src/services/expert-router/index.ts`
  - `class ExpertRouter { route(...) }`：只做编排、串联步骤
- `packages/backend/src/services/expert-router/preprocess.ts`
  - `buildRoutingSignal(request): RoutingSignal`
- `packages/backend/src/services/expert-router/decision/semantic.ts`
  - 向量路由实现（对齐 semantic-router 的 Route/Layer 思路）
- `packages/backend/src/services/expert-router/decision/heuristics.ts`
  - 硬信号/状态机修正
- `packages/backend/src/services/expert-router/decision/llm-judge.ts`
  - 复用现有 classify HTTP + JSON parse
- `packages/backend/src/services/expert-router/policy/tool-policy.ts`
  - tool 白名单/限额/风险控制
- `packages/backend/src/services/expert-router/resolve.ts`
  - model/provider resolve 与 smart routing 相关逻辑（复用现有实现）

收益：preprocess/heuristics/semantic decision 都可单测，且“工具调用信号”成为一等输入。

## 5. 与 semantic-router 对齐的可落地点

- **Route/Utterances 一等公民**：把类别定义从 prompt 里抽出来，配置化并可观测（命中率、混淆矩阵）。
- **HybridRouteLayer**：L1 向量快路由 + L3 兜底裁决（对应 margin/threshold 策略）。
- **Threshold Optimization**：利用你们已有路由日志（`expertRoutingLogDb`）做离线回放，自动寻找每类最优阈值与 margin。

## 6. 迁移与灰度路径（低风险）

1) 仅做代码拆分：`routing.mode` 默认为 `llm`，行为不变。

2) 引入 L2（规则/状态）但不引入向量：优先落地确定收益（tool result 强制 debug、slash 覆盖、意图粘滞）。

3) 灰度启用 `hybrid`：先只在“LLM classify 失败/超时/不确定”场景启用 L1；稳定后逐步变成“semantic 为主、LLM 兜底”。

4) 上线阈值训练：基于日志回放调参，稳定后扩大流量。
