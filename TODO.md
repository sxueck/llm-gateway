# 重构计划：Expert Router 分层编排 (Routing Orchestrator)

基于 `docs/expert-router-refactor.md` 和 `docs/tool-calling-protocols.md`，本计划旨在将现有的单点 Expert Router 重构为分层的路由编排器，引入语义路由、规则修正和更强的 LLM 兜底能力。

## 1. 核心类型定义与基础设施

定义新的路由架构所需的接口和类型。

- [x] **定义路由信号 (RoutingSignal)**：
  在 `packages/backend/src/services/expert-router/types.ts` 中定义：
  ```typescript
  export interface RoutingSignal {
    intentText: string;          // 核心意图文本（去噪后）
    historyHint?: string;        // 历史摘要
    toolSignals: ToolSignal[];   // 标准化的工具调用信号（来自 Tool Protocol Adapter）
    hardHints: HardHint[];       // Slash命令、特定关键词等
    originalRequest: ProxyRequest;
  }
  
  export interface ToolSignal {
    type: 'call' | 'result' | 'error';
    name?: string;
    content?: string;
    isError: boolean;
  }
  ```

- [x] **定义决策结果 (RouteDecision) 与 策略 (ToolPolicy)**：
  ```typescript
  export interface RouteDecision {
    category: string;
    confidence: number;
    source: 'l1_semantic' | 'l2_heuristic' | 'l3_llm';
    expertId?: string;
    toolPolicy?: ToolPolicy;
    metadata?: Record<string, any>;
  }

  export interface ToolPolicy {
    allowedTools?: string[]; // 白名单
    mode: 'read_only' | 'standard' | 'restricted';
  }
  ```

- [x] **定义 L1 Embedding 引擎接口**：
  在 `packages/backend/src/services/expert-router/embedding/types.ts` 定义：
  - `EmbedModel = 'bge-small-zh-v1.5' | 'all-MiniLM-L6-v2'`
  - `Embedder`：`embed(texts: string[]): Promise<Float32Array[]>`（输出需已 normalize，便于 cosine 直接点积）
  - `EmbeddingEngine`：负责模型加载、缓存目录、并发保护（单例初始化）

## 2. 预处理与协议适配 (Preprocess & Adapters)

实现请求的标准化处理，提取用于决策的信号。这部分包含原 "Tool Calling Protocols" 计划的核心内容。

- [x] **实现工具调用协议适配器 (Protocol Adapter)**：
  在 `packages/backend/src/services/expert-router/preprocess/tool-adapter.ts` 中实现：
  - `parseModelToolCalls`: 从 OpenAI Chat/Responses 和 Claude 提取统一的工具调用信息。
  - `normalizeToolResults`: 标准化工具执行结果。
  
- [x] **实现信号构建器 (Signal Builder)**：
  在 `packages/backend/src/services/expert-router/preprocess/index.ts` 中实现：
  - `buildRoutingSignal(request)`: 整合文本、Slash 命令识别和工具信号。
  - 实现去噪逻辑（去除大段代码/JSON）。
  - 但对“代码编写类任务”保留关键结构（文件路径、语言标识、diff 片段、函数/类/接口关键词）。

## 3. 决策层实现 (Decision Layers)

按 L2 -> L3 -> L1 的优先级顺序实现决策逻辑。

（说明：你们当前不需要“强制路由”，因此 L2 仅做轻量的“高置信提示/去噪/粘滞”，不做硬覆盖。）

- [x] **L2: 规则与状态修正 (Heuristics)**：
  在 `packages/backend/src/services/expert-router/decision/heuristics.ts` 中实现：
  - Slash 命令匹配 (`/debug`, `/refactor` 等)。
  - 工具信号作为“软提示”（例如：检测到 `Error/Traceback` 仅提高 `debug` 倾向，不硬覆盖）。
  - 简单的意图粘滞（Sticky Intent）：当本轮缺乏强信号时，允许继承上一轮类别（同样是软策略）。

- [x] **L3: LLM 判决 (LLM Judge) - 现有逻辑增强**：
  在 `packages/backend/src/services/expert-router/decision/llm-judge.ts` 中重构现有的 `classify` 逻辑：
  - 支持 **Tool Calling Mode**：使用结构化工具输出来确定分类（比 JSON 模式更稳）。
  - 复用 `parseModelToolCalls` 解析 LLM 响应。
  - 保留作为兜底策略。

- [x] **L1: 语义路由 (Semantic Router) - 本地小向量模型 + 内存索引**：
  在 `packages/backend/src/services/expert-router/decision/semantic.ts` 中实现“本地 embedding + 内存相似度检索”，不接入向量数据库：
  - 依赖检查：当前仓库未发现已落地的本地 embedding 推理库；建议引入 `@xenova/transformers`（CPU/WASM，Bun 可运行）。
  - 依赖接入：
    - 在 `packages/backend/package.json` 增加 `@xenova/transformers`。
    - 明确运行时约束：仅 CPU；优先使用 WASM backend；记录冷启动耗时。
  - 模型支持（用户可选）：
    - `bge-small-zh-v1.5`（中文更强，默认推荐）
    - `all-MiniLM-L6-v2`（英文/混合文本更稳）
    - 配置层面允许选择 `routing.semantic.model = 'bge-small-zh-v1.5' | 'all-MiniLM-L6-v2'`。
  - 初始化策略：进程内单例加载 pipeline（`feature-extraction` + `pooling=mean` + `normalize=true`），仅 CPU。
  - 模型缓存：支持 `TRANSFORMERS_CACHE` / `EMBED_CACHE_DIR` 指定模型缓存目录（避免每次启动重复下载/解压）；提供预下载脚本/指引。
  - 运行策略（不阻塞启动）：
    - 后端启动后异步 warmup（加载模型 + 预编码 routes）。
    - 在 warmup 未完成前：L1 返回“不确定”，直接走 L3（保证可用性）。
  - 将 `routing.semantic.routes[].utterances[]` 预先编码为 embedding，缓存到内存：`Map<routeId, Float32Array[]>`。
  - 索引结构选择（先做简单可解释的版本）：
    - v1：每条 utterance 一个向量；每类取 max 相似度作为该类分数。
    - v2（可选优化）：为每类做 centroid（均值向量）并保留若干代表 utterances 作为 tie-break。
  - 对每次请求的 `RoutingSignal.intentText` 进行编码，计算与每条 route 的相似度（建议 cosine），得到 Top1/Top2 及分数。
  - 用 `threshold` + `margin` 作为“软决策门槛”：
    - 满足阈值/间隔：产出 `source: 'l1_semantic'` 的建议类别。
    - 不满足：返回“不确定”，交给 L3 兜底。
  - 内存缓存：
    - 路由 utterances 的 embedding 常驻内存。
    - 可选：对近期 `intentText` 做 LRU embedding 缓存（以降低重复请求开销）。
  - 热更新：当 expert routing 配置变更（routes/utterances/阈值）时，重建对应索引（不影响其它 config）。
  - 观测与日志：
    - 在路由日志中记录：`l1Top1/l1Top2/threshold/margin/model/dims/latencyMs`（建议放入 `classifier_response` 的 JSON 扩展字段，避免改表）。
    - 暴露 debug 日志开关：可打印 L1 打分与命中 utterance（便于调参）。
  - utterances 来源与默认值：
    - 对齐现有 8 类（debug/explain/feature/plan/refactor/review/setup/test）。
    - 提供“默认 utterances 集”（从 `docs/prompts/category/*` 提炼 + 手工补充），用于新建配置的初始值。
  - “代码编写类任务”识别增强：
    - 预处理阶段保留关键代码意图特征（如：`implement/add/build/create`、函数/类/接口关键词、`ts/go/python`、diff/文件路径等），避免过度去噪。
    - 为 8 类每类补充覆盖“写代码/改功能/修 bug/写测试/重构/解释/规划/搭建”的代表性 utterances，用于提高 L1 分离度。

## 4. 编排与执行 (Orchestration & Resolution)

重组 `ExpertRouter` 类，串联上述模块。

- [x] **重构主类 `ExpertRouter`**：
  将 `packages/backend/src/services/expert-router.ts` 改造为编排器：
  - 流程：`Preprocess` -> `L2 Heuristics(软提示/粘滞)` -> `L1 Semantic(本地embedding)` -> `L3 LLM Judge(兜底)`。
  - 聚合最终的 `RouteDecision`。
  - 决策融合规则（避免强制路由）：
    - 若 L2 给出强提示（如 slash 命令）：可直接采纳或提高 L1/L3 prior（但不强制）。
    - 若 L1 满足 threshold/margin：使用 L1 类别。
    - 否则调用 L3。

- [x] **专家解析与策略应用 (Resolution)**：
  在 `packages/backend/src/services/expert-router/resolve.ts` 中：
  - 保持现有的 `provider/model` 解析逻辑。
  - 新增 `ToolPolicy` 的应用逻辑（虽然目前可能只是透传，但为未来风控预留位置）。

## 5. 配置与前端更新

- [x] **后端配置类型更新**：
  更新 `ExpertRoutingConfig`，增加 `routing.mode`, `routing.semantic` 等字段。
  - `routing.mode`: `llm | semantic | hybrid`（默认建议 `hybrid`，但不做强制路由：L1 不确定就走 L3）
  - `routing.semantic.model`: `'bge-small-zh-v1.5' | 'all-MiniLM-L6-v2'`
  - `routing.semantic.cacheDir`: string（可选，模型缓存目录）
  - `routing.semantic.threshold` / `routing.semantic.margin`: number
  - `routing.semantic.routes`: `{ category: string; utterances: string[] }[]`（默认提供 8 类）
  - `routing.semantic.warmup`: boolean（可选，默认 true）
  - `routing.semantic.intentTextCacheSize`: number（可选，LRU 大小）

- [x] **前端适配**：
  更新 `packages/web/src/api/expert-routing.ts` 以匹配新的配置结构。
  - UI 增加：L1 开关、模型选择、阈值/间隔、utterances 编辑器、warmup/cacheDir（可选高级项）。

## 6. 验证计划

- [x] **单元测试**：针对 Preprocess（特别是工具协议解析）和 Heuristics 编写测试。
- [ ] **回归测试**：确保现有 LLM 分类逻辑在 L3 层正常工作，且现有配置能无缝运行。
- [ ] **L1 测试（不依赖真实模型）**：
  - 用 FakeEmbedder（可控向量输出）覆盖：threshold/margin、Top1/Top2、热更新、LRU 缓存命中。
- [ ] **手工验证脚本/指引**：
  - 提供一组典型输入（8 类各 10 条），输出 L1 分数与最终类别；用于调参对比 bge vs MiniLM。
