# vLLM Semantic Router 意图信号评估数据集

`routing-eval.jsonl` —— 300 条带标注 prompt，用于评估 **vLLM Semantic Router**（`vllm-project/semantic-router`，Envoy ExtProc 架构）的 signal-driven 分类能力，聚焦 `domain` / `complexity` / `modality` 三个核心 signal。

## 背景：为什么是 signal 标注（不是 category）

vLLM Semantic Router **不输出单一 category**，而是 signal-driven decision routing：

1. **Signal 层**：把请求抽取成 **13 种 signal 类型**（`keyword` / `language` / `context` / `authz` / `domain` / `complexity` / `modality` / `embedding` / `fact_check` / `jailbreak` / `pii` / `preference` / `user_feedback`），每类含多条 rules，输出 `matched + confidence`。
2. **Decision 层**：用 Boolean 表达式组合 signals（如 `WHEN domain("code") AND complexity("hard")`）→ 命中的 decision 选模型。
3. **分类接口**：apiserver `/v1/classify/eval`（`handleEvalClassification`，`EvaluateAllSignals=true`）返回所有 signal 的命中结果。

本数据集聚焦与"意图 + 难度 + 模态"最相关的三个 signal：

| signal | 含义 | 取值 |
|---|---|---|
| `domain` | 领域分类（对应 mmBERT domain classifier / 自定义 domain rules） | `code` / `general` / `ops` |
| `complexity` | 难度（contrastive embedding，hard/easy 对比） | `easy` / `medium` / `hard` |
| `modality` | 模态（autoregressive / diffusion / both） | `text` / `multimodal` |

> 注：`domain` 的标准 mmBERT 输出是 MMLU 类别（STEM/humanities/code/...）。本数据集的 `code/general/ops` 是**业务自定义 domain 映射**，需你在 router 配置里定义对应 domain rules（如 code≈STEM+code，ops≈devops 关键词/domain 规则，general≈其余）。

## 字段 schema

每行一个 JSON 对象（JSONL）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局编号 `001`–`300` |
| `prompt` | string | 最后一条 user 消息原文（含噪声、代码块、标签，模拟真实请求） |
| `expected_signals` | object | **核心比对项**：`{domain, complexity, modality}`，对齐 `/v1/classify/eval` |
| `expected_label` | string | 8 类组合标签（见下），便于汇总报表 |
| `prompt_features` | string[] | prompt 形态特征（描述性，辅助分析预处理器/keyword 命中） |
| `reasoning_expected` | boolean | 是否应触发 reasoning mode（参考项，对应 `use_reasoning`） |
| `note` | string | 区分要点 / 易混淆说明，便于误判复盘 |

## 8 类 label → signal 组合

| `expected_label` | domain | complexity | modality |
|---|---|---|---|
| `coding_easy` | code | easy | text |
| `coding_medium` | code | medium | text |
| `coding_hard` | code | hard | text |
| `coding_multimodal` | code | (easy/medium) | multimodal |
| `chat` | general | (easy/medium) | text |
| `ops_easy` | ops | easy | text |
| `ops_medium` | ops | medium | text |
| `ops_hard` | ops | hard | text |

`chat` 与 `coding_multimodal` 的 complexity 按每条 prompt 实际推理深度单独标注（不固定）。

## 分布（300 条）

**label**：`chat:70, coding_easy:50, coding_medium:45, coding_hard:35, coding_multimodal:20, ops_easy:25, ops_medium:30, ops_hard:25`

**三维 signal**：
- `domain` → code:150, ops:80, general:70
- `complexity` → easy:129, medium:111, hard:60
- `modality` → text:280, multimodal:20

## prompt_features 词表（描述 prompt 形态）

- 代码/结构：`short_code`(≤10行), `long_code`(>10行), `task_template`(`### Task` 模板), `env_details_noise`(`<environment_details>`), `user_message_tag`(`<user_message>`), `multi_turn`
- 命令/工具：`slash_command`(`/cmd`), `tool_call`
- 意图：`single_question`, `multi_step`, `system_design`, `concurrency`, `performance`, `distributed`, `debug`, `refactor`, `api_usage`, `syntax`, `vague`
- 领域提示：`writing`, `translation`, `knowledge_qa`, `smalltalk`, `cli_basic`, `service_config`, `troubleshoot`, `k8s`, `ha`, `security`, `algorithm`, `framework`, `image_attachment`, `file_parse`

这些是描述性标签，不直接比对——但可帮你分析：当 `domain` 误判时，是 keyword signal 没命中（看 `prompt_features` 里有无 `k8s`/`service_config` 等该被 keyword rule 抓住的词），还是 domain classifier 本身错了。

## 评估用法

1. 把每条 `prompt` 作为最后一条 user message，发给 apiserver：
   ```
   POST /v1/classify/eval?trace=true
   { "text": "<prompt>" }   # 或 OpenAI messages 格式，取决于你的 apiserver 配置
   ```
2. 从返回的 signal 结果里取 `domain` / `complexity` / `modality` 三个 signal 的命中类别与 confidence。
3. 逐维度比对 `expected_signals`，统计每个 signal 的准确率、混淆矩阵。
4. confidence < 0.7 的单独看（`calculateUnifiedStatistics` 里 `lowConfidenceThreshold=0.7`）。
5. 误判项用 `prompt_features` + `note` 复盘：是 keyword/embedding signal 没抓住线索，还是 neural classifier 边界模糊。

也可走 extproc 端到端：发 `/v1/chat/completions`（model 用 auto），看 `x-selected-model` / `x-routing-confidence` 等 header 与 `expected_label` 对应的 decision 是否一致。

## 重新生成 / 校验

```bash
# 校验 JSONL 合法性 + 三维 signal 分布
node -e "
const fs=require('fs');
const lines=fs.readFileSync('routing-eval.jsonl','utf8').trim().split('\n');
const vD=new Set(['code','general','ops']),vC=new Set(['easy','medium','hard']),vM=new Set(['text','multimodal']);
const d={domain:{},complexity:{},modality:{},label:{}};
let bad=0,schemaBad=0;
for(const l of lines){
  try{
    const o=JSON.parse(l);const s=o.expected_signals;
    if(!s||!vD.has(s.domain)||!vC.has(s.complexity)||!vM.has(s.modality))schemaBad++;
    d.domain[s.domain]=(d.domain[s.domain]||0)+1;
    d.complexity[s.complexity]=(d.complexity[s.complexity]||0)+1;
    d.modality[s.modality]=(d.modality[s.modality]||0)+1;
    d.label[o.expected_label]=(d.label[o.expected_label]||0)+1;
  }catch{bad++;}
}
console.log('total',lines.length,'JSON坏行',bad,'schema错',schemaBad);
console.log(JSON.stringify(d,null,2));
"
```

---

# signals-eval.jsonl —— 13 signal 全覆盖评估

聚焦每个 signal type **单独**评估，13 个核心 signal 各 80 条（共 **1040 条**）。`routing-eval.jsonl` 测的是 domain/complexity/modality 三 signal 的组合路由；本文件测的是每个 signal 各自的识别准确率（含需要多轮对话/headers 才能判定的 signal）。

## 字段 schema

每行一个 JSON 对象：

| 字段 | 说明 |
|---|---|
| `id` | `<signal前缀>-<nnn>`，如 `keyword-001`、`feedback-014`、`authz-003` |
| `target_signal` | 13 之一（见下表） |
| `prompt` | 单条用户消息（纯文本 signal 用） |
| `messages` | 多轮对话数组（`user_feedback` / `preference` 用，OpenAI chat 格式，≥3 轮） |
| `headers` | 请求头对象（`authz` 用，含 `authorization`/`x-user-role` 等） |
| `expected` | 该 signal 的预期输出（结构随 signal 不同，见下表） |
| `note` | 边界/易混淆说明 |

## 13 signal 的 `expected` 结构

| signal | 输入形式 | expected | 取值 |
|---|---|---|---|
| `keyword` | prompt | `{matched_rule, matched_keywords[]}` | rule: coding/reasoning/math/creative/ops_keywords |
| `language` | prompt | `{language}` | zh/en/ja/ko/mixed/fr/es/de |
| `context` | prompt | `{bucket, approx_tokens}` | bucket: short(<128t)/medium(128-512)/long(512-2048)/very_long(>2048) |
| `domain` | prompt | `{domain}` | code/math/creative/science/humanities/general |
| `complexity` | prompt | `{complexity}` | easy/medium/hard |
| `modality` | prompt | `{modality}` | text/image_generation/multimodal_input |
| `embedding` | prompt | `{anchor, expected_match}` | anchor: coding_help/math_solving/creative_writing/casual_greeting/concept_explanation |
| `fact_check` | prompt | `{requires_fact_check, category}` | category: factual(→true)/creative/code/opinion/math(→false) |
| `jailbreak` | prompt | `{is_jailbreak, threat_type}` | threat_type: prompt_injection/role_play/dan/payload_splitting/encoding/authority_appeal/other/none |
| `pii` | prompt | `{has_pii, pii_types[]}` | types: email/phone/ssn/credit_card/name/address/id_number/passport/ip_address/bank_account |
| `user_feedback` | messages | `{feedback}` | satisfied/wrong_answer/need_clarification/want_different |
| `preference` | messages | `{preference}` | concise/detailed/formal/casual/code_first/explain_first |
| `authz` | headers | `{authorized, reason}` | reason: valid(→true)/expired_token/insufficient_role/missing_token/revoked(→false) |

> 设计要点：`keyword` 的 `matched_keywords` 必须真实出现在 prompt 里；`embedding` 的 true 样本刻意换措辞（测语义而非关键词）；`jailbreak` 含 15 条边缘正常样本（防误判）；`pii` 含 15 条占位/示例值（如 `user@example.com`、测试卡号）防误判；`authz` 的 `missing_token` 场景 headers 里不含任何 token。

## 评估用法

```bash
# 纯文本 signal：单条 prompt
POST /v1/classify/eval  { "text": "<prompt>" }
→ 取返回的对应 signal 结果比对 expected

# 多轮 signal (user_feedback/preference)：发完整 messages
POST /v1/chat/completions  { "messages": [...] }
→ 从对话推断 feedback/preference，比对 expected

# authz：带 headers
POST /v1/chat/completions  (headers: authorization/x-user-role/...)
→ 比对 authorized + reason
```

逐 signal 统计准确率与混淆矩阵；`jailbreak`/`pii` 额外看 false-positive（正常样本被误判）。

## 校验

```bash
node -e "
const fs=require('fs');
const L=fs.readFileSync('signals-eval.jsonl','utf8').trim().split('\n');
const dist={};const ids=new Set();let bad=0,dup=0;
for(const l of L){try{const o=JSON.parse(l);dist[o.target_signal]=(dist[o.target_signal]||0)+1;if(ids.has(o.id))dup++;ids.add(o.id);}catch{bad++;}}
console.log('total',L.length,'坏行',bad,'重复id',dup,'signal数',Object.keys(dist).length);
console.log(JSON.stringify(dist));
"
```

## 文件

- `routing-eval.jsonl` —— domain/complexity/modality 三 signal 组合路由评估（300 条）
- `signals-eval.jsonl` —— 13 signal 全覆盖单 signal 评估（1040 条）
- `routing-eval.v1-flat.jsonl` —— 旧版扁平 category 标注（备份，针对 llm-gateway ExpertRouter 的 LLM-as-Judge 架构，不适用于 vLLM Semantic Router）
- `README.md` —— 本文档
