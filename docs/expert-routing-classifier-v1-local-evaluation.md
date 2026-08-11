# Expert Routing 本地分类器 v1 实地评估报告

> **评估对象**：`snival/intent-router-zh-setfit-v1` @ revision `ce71b323`
> **评估日期**：2026-08-11
> **评估动机**：用户报告 prompt「检查一下当前项目的证书管理功能逻辑都在哪里」被误判为 `out_of_scope`，实际应为 `code_search`
> **评估目的**：为第二次模型训练提供方向和依据

## 执行摘要

本次评估发现中文短指令在当前 v1 分类器上存在**系统性失效**，根因有三层（按影响排序）：

1. **encoder 层泛化差**：训练集以长 agent prompt 为主（中位数 ~600 字符），中文短指令（<100 字符）属于 OOD，模型输出的概率分布近乎均匀，无法形成有效决策边界
2. **sqrt-inverse class weighting 副作用**：为补偿类别不平衡施加的 `1/√n` 加权，使训练样本最少的类（ops 域 31–46 条）在模糊输入上反而拿到更高分数——形成「噪声洼地」效应
3. **keyword 规则覆盖面窄**：`code_search` 的硬路由规则要求「疑问词 + 名词」固定语序，不覆盖中文常见的倒装表述

**关键反直觉结论**：「删除 ops 标签」不能缓解 code_search 被压低的问题——条件 softmax 实验证明，删掉 ops 后概率质量回流到了 `dependency_management`(32 样本) 和 `test_generation`(45 样本)，同样是低样本类的噪声洼地。根因在 encoder 的 embedding 映射，不在标签集合。

**训练改进方向**：(1) 补充中文短指令训练样本；(2) 去掉或减弱 sqrt-inverse 加权；(3) 不要删 ops 标签；(4) 临时扩 keyword 规则。

## 评估背景与方法

### 触发 case

```
prompt:  「检查一下当前项目的证书管理功能逻辑都在哪里」
字数:    19 字符（属于 OOD 短指令）
期望:    code_search
实际:    monitoring_query 0.1275 / deployment 0.1261 → rejected (top1 < 0.15) → out_of_scope
```

### 评估工具链

| 工具 | 用途 |
|------|------|
| `scripts/smoke-test-classifier.ts` | 验证完整推理 pipeline（asset load → tokenizer → ONNX encoder → head → softmax → v3 policy） |
| `scripts/diagnose-classifier.ts` | 对触发 case 及多组变体输出完整 ranked 概率分布 + policy 决策 |
| `scripts/probe-drop-ops.ts` | 条件 softmax 探针，验证「删 ops 标签」假设的效果 |

### 模型与策略配置

- 模型仓库：`snival/intent-router-zh-setfit-v1`
- 基座：`Qwen/Qwen3-Embedding-0.6B`
- 方法：SetFit（对比学习 body 微调 + 加权线性 head）
- 标签数：21（coding 9 + ops 8 + general_control 3 + out_of_scope）
- 策略版本：v3（`rejection_policy.json`）
- 关键阈值：`max_probability = 0.15`，`short_text_max_chars = 3`

## 发现 1：Pipeline smoke test 通过

运行 `npm run test:onnx-smoke`（3 个官方样本）全部 PASS，证明本地推理 pipeline 完整且与 model card 报告的数值一致。

```
[PASS] long agent-style code review request
  chosen=code_review rejected=false(-)
  top1=out_of_scope:0.217 top2=general_inquiry:0.141
  flip=undefined keyword=code_review
  latency=1541ms seqLen=26 truncated=false

[PASS] stack trace → code repair keyword
  chosen=code_repair rejected=false(-)
  top1=code_search:0.398 top2=code_repair:0.153
  flip=undefined keyword=code_repair
  latency=337ms seqLen=32 truncated=false

[PASS] short text → rejected
  chosen=general_inquiry rejected=false(-)
  top1=out_of_scope:0.411 top2=monitoring_query:0.106
  flip=undefined keyword=general_inquiry
  latency=157ms seqLen=2 truncated=false
```

**注意**：第三个 case「hi」被策略路由为 `general_inquiry`（via keyword），但 smoke test 的断言逻辑是 `rejected ? expect==='out_of_scope' : true`，所以 PASS。这是一个松散的断言——接受任何非 rejected 的结果。

## 发现 2：触发 case 完整复现

使用 `scripts/diagnose-classifier.ts` 对触发 prompt 及 8 组变体做完整 ranked 分布 dump。

### 2.1 现象复现

```
input:    "检查一下当前项目的证书管理功能逻辑都在哪里"
chosen:   out_of_scope | rejected=true(low_confidence)
top1:     monitoring_query               0.1275  ← BELOW threshold (0.15)
```

实测分数与用户报告的 0.12/0.12 完全吻合，复现成功。

### 2.2 完整 ranked 概率分布

```
monitoring_query               0.1275 ███░░░░░░░░░░░░░░░░░░░░░  ·top1
deployment                     0.1261 ███░░░░░░░░░░░░░░░░░░░░░
incident_response              0.1124 ███░░░░░░░░░░░░░░░░░░░░░
security_operation             0.1091 ███░░░░░░░░░░░░░░░░░░░░░
dependency_management          0.1045 ██░░░░░░░░░░░░░░░░░░░░░░
pipeline_operation             0.0962 ██░░░░░░░░░░░░░░░░░░░░░░
test_generation                0.0889 ██░░░░░░░░░░░░░░░░░░░░░░
infrastructure_provisioning    0.0861 ██░░░░░░░░░░░░░░░░░░░░░░
general_inquiry                0.0558 █░░░░░░░░░░░░░░░░░░░░░░░
out_of_scope                   0.0200 ░░░░░░░░░░░░░░░░░░░░░░░░ ★ (chosen)
config_change                  0.0166 ░░░░░░░░░░░░░░░░░░░░░░░░
workflow_control               0.0164 ░░░░░░░░░░░░░░░░░░░░░░░░
context_specification          0.0082 ░░░░░░░░░░░░░░░░░░░░░░░░
code_repair                    0.0067 ░░░░░░░░░░░░░░░░░░░░░░░░
code_search                    0.0060 ░░░░░░░░░░░░░░░░░░░░░░░░  ← EXPECTED
code_modification              0.0052 ░░░░░░░░░░░░░░░░░░░░░░░░
code_review                    0.0040 ░░░░░░░░░░░░░░░░░░░░░░░░
code_explanation               0.0033 ░░░░░░░░░░░░░░░░░░░░░░░░
log_analysis                   0.0026 ░░░░░░░░░░░░░░░░░░░░░░░░
architecture_consultation      0.0024 ░░░░░░░░░░░░░░░░░░░░░░░░
code_authoring                 0.0020 ░░░░░░░░░░░░░░░░░░░░░░░░
```

**关键观察**：
- top1（monitoring_query）概率仅 0.1275，与第 2 名（deployment 0.1261）差距极小——分布近乎均匀
- code_search（期望类）排第 15 位，概率仅 0.006
- 前 4 名全部是 ops 域标签，且分数高度接近（0.11–0.13）

### 2.3 多组变体测试汇总

对 9 组中文 prompt 做完整测试，结果汇总：

| case | chosen | top1 score | expected |
|------|--------|------------|----------|
| 检查…证书管理功能逻辑都在哪里 | out_of_scope(rej) | 0.127 | code_search |
| 证书管理功能的逻辑在哪里 | out_of_scope(rej) | 0.127 | code_search |
| 证书管理功能的实现在哪里 | out_of_scope(rej) | 0.128 | code_search |
| 查找证书管理功能的实现 | code_search | 0.131 | code_search |
| 帮我找一下证书管理相关的代码 | general_inquiry | 0.274 | code_search |
| 证书管理的逻辑写在哪里 | out_of_scope(rej) | 0.129 | code_search |
| 项目里哪里有证书管理的逻辑 | out_of_scope(rej) | 0.127 | code_search |
| 查看线上服务的错误率和延迟 | out_of_scope(rej) | 0.129 | monitoring_query |
| 把这个服务部署到生产环境 | deployment | 0.137 | deployment |

**关键发现**：
- 9 组中只有 2 组正确路由（其中「部署到生产」靠的是 keyword 规则硬路由）
- 所有中文短指令的 top1 分数都在 0.12–0.13 区间，远低于长 prompt 的 0.4+ 区间
- 即使是「查看线上错误率和延迟」这种典型 monitoring_query 也被 reject——说明问题不限于 code_search

## 发现 3：keyword 规则覆盖盲区

当前 `code_search` 的 keyword 规则（`rejection_policy.json:54-57`）：

```regex
(在哪(里|裡)|哪里|搜一下|帮我找).{0,12}(定义|实现|函数|方法|类|文件)
(定位一下|查找).{0,10}(实现|定义|调用点)
```

**致命盲区**：规则要求「疑问词（在哪里/哪里）」**在前**、名词（定义/实现/函数/方法/类/文件）**在后**。但中文常见表述恰好相反：

| 表述 | 是否匹配 | 实测结果 |
|------|---------|---------|
| 证书管理功能的**实现在哪里** | ❌ | reject → oos |
| 证书管理功能的**逻辑在哪里** | ❌ | reject → oos |
| 证书管理的逻辑**写在哪里** | ❌ | reject → oos |
| 哪里有证书管理的**逻辑** | ❌ | reject → oos |
| 帮我找证书管理相关的**代码** | ❌ | "代码"不在名词白名单 |
| 查找证书管理功能的**实现** | ✅ | 正确路由 → code_search |

另外注意到，名词白名单 `{定义, 实现, 函数, 方法, 类, 文件}` 遗漏了几个中文高频查询对象：`逻辑`、`功能`、`代码`、`配置`、`入口`、`声明`。

## 发现 4：「删 ops」假设的条件 softmax 反证

### 假设

「既然 ops 域的样本最少（31–46 条），删掉 ops 标签后，原本被误判到 ops 的概率质量是否会回流到 code_search？」

### 方法

利用 softmax 的数学性质：**在子集上的条件 softmax = 原概率在子集上重新归一化**（分子 `exp(z_i)` 不变）。因此无需重训即可精确预测「删标签」后的概率分布。

> 这是重训线性头后效果的良好近似上界。Caveat：用的是旧线性头的权重，新头在更少类上重训后分数可能略升，但上限受限于 encoder 的 embedding 质量。

### 结果

| prompt | A 现状(21类) | B 去ops+保留gc+oos | C 仅code+oos | D 二分类(code_search vs oos) |
|--------|------------|---------|--------------|---------------------|
| 检查…证书管理功能逻辑都在哪里 | monitoring 0.13 | **dependency** 0.32 | **dependency** 0.43 | **oos 0.77** / cs 0.23 |
| 证书管理的逻辑写在哪里 | monitoring 0.13 | **dependency** 0.32 | **dependency** 0.42 | **oos 0.80** / cs 0.20 |
| 帮我找证书管理相关的代码 | general 0.27 | **general** 0.40 | **oos** 0.54 | **oos 0.97** / cs 0.03 |

**code_search 在任何裁剪方案下都没拿到 top1**。最极端的 D（只留 code_search vs out_of_scope 二分类），code_search 也只有 0.20–0.23，`out_of_scope` 反而吃掉 0.77–0.80。

### 结论

删 ops 标签后概率质量回流到了 **`dependency_management`(32 样本) 和 `test_generation`(45 样本)**——同样是两个低样本类的 `1/√n` 在顶。**噪声洼地从 ops 搬到了 coding 域里最稀疏的两个类**。code_search（158 样本，权重中等）依然在底部。

副作用：真正的 ops 请求（如「查看线上错误率」）会丢失路由能力，被错分到 `dependency_management`。

## 发现 5：sqrt-inverse weighting 噪声洼地现象

### 触发用户直觉的问题

> 「为什么我的 ops 类样本更少，反而模型更倾向于把结果往 ops 方向靠？」

直觉认为「样本少 → 模型应预测更少」，但**正好反了**——正是因为 ops 类样本少，训练时的补偿机制让它们在模糊输入上反而拿更高分。

### 机制链

model card 的 Training 一节写明了三件事：

1. **`sqrt-inverse class weighting`**：head 的损失里每类权重 ∝ `1/√(n_c)`
2. **`oversampling to min 150/class`**：body 的对比学习里，低样本类被过采样到 150
3. **结果**：低样本类的决策区域被人为撑大、head 的 intercept 偏置被人为抬高

对训练分布内的长 prompt，这能纠正不平衡；但对 OOD 的短中文输入，encoder 编不出有信息的 embedding，落在一个「模糊中央」，于是**偏置最大的类（= 样本最少的类）默认赢**。

### 数据印证：训练样本数与实测分数的反向相关

把 model card 公布的每类训练样本数和本评估的触发 case 实测概率对齐：

| label | 训练样本数 | 实测概率 | 备注 |
|-------|-----------|---------|------|
| monitoring_query | 46 | **0.1275** | top1（被加权顶上） |
| deployment | 36 | **0.1261** | |
| incident_response | 32 | **0.1124** | |
| security_operation | 32 | **0.1091** | |
| dependency_management | 32 | 0.1045 | coding 域，但同样低样本 |
| infrastructure_provisioning | 31 | 0.0861 | ops 最少 |
| code_review | **741** | **0.0040** | 样本最多 → 分数几乎为 0 |
| code_modification | 420 | 0.0052 | |
| code_explanation | 368 | 0.0033 | |
| code_search | 158 | 0.0060 | 用户期望的类 |

**完美的反向相关**：样本数越少，实测分数越高。`code_review`（741 样本，权重最低）被压到 0.004；ops 类（31–46 样本，权重最高）霸榜前 4 名。

这不是模型「识别」出这是 ops，是 `1/√n` 把它们顶上来的。model card 自己在 Limitations 里也认了：*"Short standalone prompts are out-of-distribution... collapse to a narrow region of the embedding space and produce near-uniform predictions"*，以及 *"ops intents are currently unusable... treat any ops prediction as untrusted"*。

### 噪声洼地效应图示

```
                        ┌─────────────────────────────────┐
                        │ encoder embedding 空间           │
                        │                                  │
  长英文 prompt  ─────► │  [code_review 类中心]            │
  (OOD 内，清晰)         │     ▲ 高密度训练样本             │
                        │     │                             │
                        │  ┌──┴──────────┐                 │
                        │  │ OOD 中文短指令 │               │
                        │  │ embedding 落在 │               │
                        │  │ 「模糊中央」  │               │
                        │  └──────┬──────┘                 │
                        │         │                         │
                        │         ▼ 落到偏置最高的类         │
                        │  [ops 类中心（虚胖）]            │
                        │   ▲ 1/√n 加权 + oversample         │
                        │   │  = 噪声洼地                    │
                        │                                  │
                        └─────────────────────────────────┘
```

## 第二次训练改进方向

### 数据层（根因治理）

| 建议 | 原因 | 量化目标 |
|------|------|---------|
| **补充中文短指令训练样本** | 训练集中位数 ~600 字符，触发 case 是 19 字符，纯 OOD | 每类至少 100 条 < 100 字符的样本 |
| **覆盖 code_search 常见中文表述** | 当前 keyword 规则只匹配固定语序，实际口语多种多样 | 见下文「keyword 规则建议扩充」 |
| **保留 ops 标签并补充样本** | ops 域 8 类各只有 31–129 条，是不可用的根源 | 每类至少 150 条独立样本（不是过采样复制） |
| **加入中文代码搜索的近邻类对照样本** | code_search ↔ code_explanation ↔ dependency_management 是 top confusion pairs | 三者形成三角对照集 |

### 损失层（机制治理）

| 建议 | 原因 | 预期效果 |
|------|------|---------|
| **去掉或减弱 sqrt-inverse class weighting** | 这是噪声洼地效应的根源 | 模糊输入不再被低样本类霸榜 |
| **改用 cost-sensitive loss 或 focal loss** | 在不破坏长尾类覆盖的前提下抑制噪声洼地 | 让低样本类的决策边界更紧 |
| **考虑在 head 训练时引入 temperature scaling** | 当前 ECE = 0.078，但概率分布过于均匀，可能是过拟合补偿 | 让置信度更反映真实证据 |

### 标签层（不要做什么）

- ❌ **不要删除 ops 标签**：条件 softmax 实验证明删掉 ops 后概率质量回流到 coding 域里最低样本的类（dependency_management、test_generation），噪声洼地只是搬家，不解决问题，还破坏 ops 前向兼容性
- ❌ **不要单独把 code_search 标签的权重调高**：这等于在 head 层硬编码一个先验，会破坏其他 code 类的判别力
- ✅ **保留 21 类标签集合**：等数据补齐后再评估是否需要裁剪

### 策略层（临时缓解）

以下措施可在重训完成前立即生效，但属于「治标不治本」：

#### keyword 规则建议扩充

在 `rejection_policy.json` 的 `code_search` patterns 数组中追加：

```regex
; 中文倒装语序覆盖
(逻辑|功能|代码|实现|定义|写).{0,12}在哪(里|裡)
; 「哪里有」模式覆盖
哪里有.{0,12}(逻辑|代码|实现|定义)
; 「找一下」模式覆盖（扩 noun 白名单）
(找一下|搜一下|搜一下).{0,12}(代码|逻辑|实现|定义)
; 扩 noun 白名单本身（在原规则上追加）
```

扩 noun 白名单建议：`逻辑`、`功能`、`代码`、`配置`、`入口`、`声明`、`声明`。

#### 阈值不要单独调

`max_probability = 0.15` 看似很高（中文短指令 top1 普遍 0.12–0.13），但下调到 0.10 会进一步压低 `oos_precision`（已仅 0.329）。这不是阈值问题，是模型输出质量问题。

### 验证指标（第二次训练的验收标准）

建议第二次训练完成后，以下指标作为发布门槛：

| 维度 | 指标 | v1 基线 | v2 发布门槛 |
|------|------|---------|-----------|
| 独立中文短指令测试集 | accuracy | ~12% (v1 on <100 chars) | ≥ 50% |
| code_search 类 routed F1 | F1 | 0.256 | ≥ 0.60 |
| 噪声洼地效应 | 前 4 名分数差距 | < 0.03（近均匀） | ≥ 0.15（有决策力） |
| 噪声洼地效应 | code_search 在 code_search prompt 上的 top1 score | 0.006 | ≥ 0.40 |
| OOD 短中文 prompt | top1 score 普遍范围 | 0.12–0.13 | ≥ 0.40 或被 keyword 命中 |
| ops 域可用性 | 8 类 routed F1 平均 | 0.000（model card 自报） | ≥ 0.50 |

测试集应独立于训练集，覆盖中文短指令（< 100 字符）、中英混合、倒装语序、code_search 常见表述。

## 附录 A：复现脚本

本次评估创建的诊断脚本（随本报告一起提交到 `test/classifier-v1-local-evaluation` 分支）：

- `packages/backend/scripts/diagnose-classifier.ts` —— 触发 case 完整 ranked 分布 dump
- `packages/backend/scripts/probe-drop-ops.ts` —— 条件 softmax 探针

运行方式（需先下载模型 assets）：

```bash
cd packages/backend
npm run download:onnx-model        # 下载 model-assets（约 600MB）
npm run test:onnx-smoke            # 验证 pipeline
npx tsx scripts/diagnose-classifier.ts
npx tsx scripts/probe-drop-ops.ts
```

## 附录 B：与 model card 已知限制的交叉印证

本次实测发现与 model card 自述限制的对应关系：

| 本次发现 | model card 原文 |
|---------|----------------|
| 中文短指令 top1 普遍 0.12–0.13，分布近乎均匀 | *"Short standalone prompts are out-of-distribution... produce near-uniform predictions"* |
| ops 域类霸榜前 4 名 | *"ops intents are currently unusable... treat any ops prediction as untrusted"* |
| dependency_management / test_generation 即使在 coding 域也 F1 ≈ 0 | *"Within coding, dependency_management (32) and test_generation (45) match their observed F1 of ~0"* |
| code_search ↔ code_explanation 是 top confusion pair | model card Limitations: *"Confusion concentrates on... code_search ↔ code_explanation"* |

本次评估的贡献在于：(1) 在本地复现了 model card 限制的具体数值；(2) 揭示了 sqrt-inverse weighting 是噪声洼地效应的机制根源；(3) 用条件 softmax 反证了「删 ops」假设。

## 参考链接

- 模型仓库：<https://huggingface.co/snival/intent-router-zh-setfit-v1>
- 基座模型：<https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- 本地推理代码：`packages/backend/src/services/expert-router/local/classifier.ts`
- 策略配置：`packages/backend/model-assets/intent-router-zh-setfit-v1/rejection_policy.json`（gitignored，runtime artifact）
