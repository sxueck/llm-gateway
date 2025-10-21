# LLM Gateway 专家路由 (Expert Routing) 技术设计文档

**版本**: v2.1 (简化版)
**更新日期**: 2025-10-21
**状态**: 设计阶段

## 变更日志

### v2.1 (2025-10-21) - 简化版
- 移除缓存机制,每次请求实时调用分类模型
- 简化专家选择逻辑,仅保留精确匹配
- 移除模糊匹配和大小写敏感选项
- 调整可视化布局: 专家入口(左) → 分类器(中) → 目标模型(右)
- 简化可视化交互,移除拖拽、缩放、平移功能
- 更新为静态展示 + 点击编辑模式

### v2.0 (2025-10-21) - 实验性功能版
- 将专家路由定位为独立的实验性功能
- 支持虚拟模型和实际模型作为后端
- 设计独立的配置页和可视化编辑器
- 新增专家路由配置表和日志表

### v1.0 (2025-10-21) - 初始版本
- 基础专家路由设计
- 作为路由配置的一种类型

---

## 1. 功能概述

专家路由是一个**实验性功能**,通过分类模型智能识别请求类型,然后将请求路由到专门的"专家"模型。这种机制可以实现:

- **任务专业化**: 不同类型的任务由最擅长的模型处理
- **成本优化**: 简单任务使用轻量级模型,复杂任务使用高级模型
- **性能提升**: 专门训练的模型在特定领域表现更好
- **灵活扩展**: 可以根据业务需求动态调整路由策略

### 1.1 功能定位

- **实验性功能**: 作为独立的实验性功能,与 Prompt 管理并列
- **独立配置页**: 拥有专门的配置界面,功能完善且可选项丰富
- **可视化设计**: 使用流程图样式展示分类和路由逻辑
- **后端灵活性**: 支持虚拟模型和实际供应商模型作为专家

### 1.2 应用场景示例

- **客服系统**: 简单问题 → 快速模型,复杂问题 → 高级模型
- **代码助手**: 代码生成 → 代码专家模型,文档编写 → 通用模型
- **多语言支持**: 根据语言类型路由到对应语言的专家模型
- **领域专家**: 医疗、法律、金融等领域路由到专门训练的模型

## 2. 架构设计

### 2.1 整体架构

专家路由作为实验性功能,独立于现有的智能路由(负载均衡/故障转移)系统:

```
客户端请求
    ↓
虚拟密钥认证 (Virtual Key Auth)
    ↓
检查模型配置
    ↓
    ├─ 是否启用专家路由? (expert_routing_id)
    │   ├─ 否 → 现有路由逻辑
    │   │       ├─ 虚拟模型 (智能路由)
    │   │       └─ 实际模型 (直接转发)
    │   │
    │   └─ 是 → [新增] 专家路由流程
    │           ↓
    │       分类模型调用 (Classifier Model)
    │           ↓
    │       分类结果解析
    │           ↓
    │       专家模型选择 (Expert Selection)
    │           ↓
    │       更新请求上下文
    │           ↓
    │       专家可以是:
    │       ├─ 虚拟模型 (带智能路由)
    │       └─ 实际模型 (直接转发)
    ↓
Provider 解析
    ↓
Portkey Gateway 选择
    ↓
请求转发
    ↓
响应返回
```

### 2.2 核心组件设计

#### 2.2.1 专家路由配置 (Expert Routing Config)

专家路由作为独立的实验性功能,拥有自己的配置表和数据结构:

```typescript
interface ExpertRoutingConfig {
  id: string;                      // 配置 ID
  name: string;                    // 配置名称
  description?: string;            // 配置描述
  enabled: boolean;                // 是否启用

  classifier: {
    // 分类模型配置 - 支持虚拟模型或实际模型
    type: 'virtual' | 'real';      // 模型类型
    model_id?: string;             // 虚拟模型 ID (type=virtual)
    provider_id?: string;          // Provider ID (type=real)
    model?: string;                // 模型名称 (type=real)
    prompt_template: string;       // 分类提示词模板
    max_tokens?: number;           // 分类响应最大 token 数
    temperature?: number;          // 温度参数
    timeout?: number;              // 超时时间(ms)
  };

  experts: ExpertTarget[];         // 专家模型列表

  fallback?: {
    // 分类失败时的降级策略
    type: 'virtual' | 'real';      // 模型类型
    model_id?: string;             // 虚拟模型 ID (type=virtual)
    provider_id?: string;          // Provider ID (type=real)
    model?: string;                // 模型名称 (type=real)
  };
}

interface ExpertTarget {
  id: string;                      // 专家 ID
  category: string;                // 分类类别名称(必须与分类结果完全一致)
  type: 'virtual' | 'real';        // 模型类型
  model_id?: string;               // 虚拟模型 ID (type=virtual)
  provider_id?: string;            // Provider ID (type=real)
  model?: string;                  // 模型名称 (type=real)
  description?: string;            // 专家描述
  color?: string;                  // 可视化显示颜色
}
```

#### 2.2.2 专家路由服务 (Expert Router Service)

新增 `src/services/expert-router.ts`:

```typescript
export class ExpertRouter {
  // 执行专家路由
  async route(
    request: ProxyRequest,
    expertRoutingId: string,
    context: RoutingContext
  ): Promise<ExpertRoutingResult>;

  // 调用分类模型(支持虚拟模型和实际模型)
  private async classify(
    messages: ChatMessage[],
    classifierConfig: ClassifierConfig
  ): Promise<string>;

  // 选择专家模型(精确匹配)
  private selectExpert(
    category: string,
    experts: ExpertTarget[]
  ): ExpertTarget | null;

  // 解析专家模型(虚拟模型或实际模型)
  private async resolveExpertModel(
    expert: ExpertTarget
  ): Promise<ResolvedModel>;
}
```

#### 2.2.3 分类结果处理

分类结果采用实时调用方式,不进行缓存:

```typescript
// 分类结果直接返回,不缓存
interface ClassificationResult {
  category: string;              // 分类结果
  classificationTime: number;    // 分类耗时(ms)
}
```

**说明**:
- 每次请求都实时调用分类模型
- 不进行缓存,确保分类结果的实时性和准确性
- 简化实现复杂度,降低维护成本

### 2.3 数据库设计

#### 2.3.1 新增专家路由配置表

专家路由作为独立功能,拥有独立的配置表:

```sql
CREATE TABLE expert_routing_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  config TEXT NOT NULL,            -- JSON 格式存储 ExpertRoutingConfig
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_expert_routing_configs_enabled ON expert_routing_configs(enabled);
CREATE INDEX idx_expert_routing_configs_created_at ON expert_routing_configs(created_at);
```

#### 2.3.2 扩展 models 表

在 models 表中新增字段,用于关联专家路由配置:

```sql
-- 新增字段(通过 migration)
ALTER TABLE models ADD COLUMN expert_routing_id TEXT;

-- 添加索引
CREATE INDEX idx_models_expert_routing ON models(expert_routing_id);

-- 外键约束
-- FOREIGN KEY (expert_routing_id) REFERENCES expert_routing_configs(id) ON DELETE SET NULL
```

**说明**:
- `expert_routing_id` 与 `routing_config_id` 互斥,一个模型只能启用一种路由方式
- 当 `expert_routing_id` 不为空时,优先使用专家路由
- 专家路由可以指向虚拟模型或实际模型

#### 2.3.3 新增专家路由日志表

用于记录分类结果和路由决策,便于分析和优化:

```sql
CREATE TABLE expert_routing_logs (
  id TEXT PRIMARY KEY,
  virtual_key_id TEXT,
  expert_routing_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,      -- 请求内容哈希
  classifier_model TEXT NOT NULL,  -- 分类器模型标识
  classification_result TEXT NOT NULL,  -- 分类结果
  selected_expert_id TEXT NOT NULL,     -- 选中的专家 ID
  selected_expert_type TEXT NOT NULL,   -- 专家类型(virtual/real)
  selected_expert_name TEXT NOT NULL,   -- 专家名称(用于显示)
  classification_time INTEGER,     -- 分类耗时(ms)
  created_at INTEGER NOT NULL,
  FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE SET NULL,
  FOREIGN KEY (expert_routing_id) REFERENCES expert_routing_configs(id) ON DELETE CASCADE
);

CREATE INDEX idx_expert_routing_logs_config ON expert_routing_logs(expert_routing_id);
CREATE INDEX idx_expert_routing_logs_created_at ON expert_routing_logs(created_at);
CREATE INDEX idx_expert_routing_logs_category ON expert_routing_logs(classification_result);
```

## 3. 配置方式

### 3.1 独立配置页面

专家路由作为实验性功能,拥有独立的配置页面,位于菜单的"实验性功能"分组下:

```
菜单结构:
├─ 实验性功能
│  ├─ Prompt 管理
│  └─ 专家路由 [新增]
```

### 3.2 配置页面布局

专家路由配置页面包含以下部分:

#### 3.2.1 配置列表区域

- 显示所有已创建的专家路由配置
- 支持启用/禁用、编辑、删除、复制操作
- 显示配置的基本信息:名称、描述、专家数量、启用状态
- 显示统计信息:使用次数、缓存命中率、平均分类耗时

#### 3.2.2 配置编辑器

点击"创建"或"编辑"按钮后,打开配置编辑器,包含以下步骤:

**步骤 1: 基本信息**
- 配置名称
- 配置描述
- 是否启用

**步骤 2: 分类器配置**
- 模型类型选择: 虚拟模型 / 实际模型
  - 虚拟模型: 从下拉列表选择已创建的虚拟模型
  - 实际模型: 选择 Provider + 模型名称
- 分类提示词模板(支持 `{{user_prompt}}` 占位符)
- 分类参数:
  - Max Tokens
  - Temperature
  - Timeout

**步骤 3: 专家配置(可视化编辑器)**
- 使用流程图样式展示分类和路由逻辑
- 左侧: 分类器节点
- 右侧: 专家节点列表
- 连接线: 表示分类结果到专家的映射关系

专家节点配置:
- 分类类别名称
- 模型类型: 虚拟模型 / 实际模型
  - 虚拟模型: 从下拉列表选择
  - 实际模型: 选择 Provider + 模型名称
- 描述信息
- 优先级
- 显示颜色(用于可视化)

**步骤 4: 降级策略**
- 是否启用降级
- 降级模型类型: 虚拟模型 / 实际模型
- 降级模型选择

**步骤 5: 关联模型**
- 选择要应用此专家路由的模型
- 支持多选
- 显示已关联的模型列表

### 3.3 可视化编辑器设计

使用简化的流程图样式展示专家路由配置:

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  专家路由    │      │   分类器     │      │   simple    │
│   入口      │ ───> │ gpt-4o-mini │ ───> │  快速模型    │
│             │      │  (虚拟模型)  │      │   (实际)     │
└─────────────┘      └─────────────┘      └─────────────┘
                            │
                            ├──────────> ┌─────────────┐
                            │            │   medium    │
                            │            │  中等模型    │
                            │            │   (虚拟)     │
                            │            └─────────────┘
                            │
                            └──────────> ┌─────────────┐
                                         │   complex   │
                                         │  高级模型    │
                                         │   (虚拟)     │
                                         └─────────────┘
```

**布局说明**:
- **左侧**: 专家路由入口节点(固定显示)
- **中间**: 分类器节点
- **右侧**: 目标模型节点列表(根据专家配置自动生成)
- **流程方向**: 从左到右,符合阅读习惯

**交互方式**(简化):
- 点击节点可以编辑配置
- 连接线自动根据配置数据生成
- 不支持拖拽、缩放、平移等复杂交互
- 主要用于静态展示路由逻辑,而非可视化编辑器

### 3.4 配置示例

#### 示例 1: 客服系统专家路由

```json
{
  "id": "expert-routing-1",
  "name": "客服专家路由",
  "description": "根据问题复杂度路由到不同模型",
  "enabled": true,
  "classifier": {
    "type": "real",
    "provider_id": "openai-provider",
    "model": "gpt-4o-mini",
    "prompt_template": "请分析以下用户问题的复杂度,并分类为: simple(简单问题)、medium(中等问题)、complex(复杂问题)。只返回分类结果,不要解释。\n\n用户问题: {{user_prompt}}",
    "max_tokens": 10,
    "temperature": 0.1,
    "timeout": 5000
  },
  "experts": [
    {
      "id": "expert-1",
      "category": "simple",
      "type": "real",
      "provider_id": "deepseek-provider",
      "model": "deepseek-chat",
      "description": "处理简单问题的快速模型",
      "priority": 1,
      "color": "#52c41a"
    },
    {
      "id": "expert-2",
      "category": "medium",
      "type": "virtual",
      "model_id": "virtual-model-1",
      "description": "处理中等复杂度问题",
      "priority": 2,
      "color": "#1890ff"
    },
    {
      "id": "expert-3",
      "category": "complex",
      "type": "real",
      "provider_id": "openai-provider",
      "model": "gpt-4o",
      "description": "处理复杂问题的高级模型",
      "priority": 3,
      "color": "#f5222d"
    }
  ],
  "fallback": {
    "type": "real",
    "provider_id": "openai-provider",
    "model": "gpt-4o-mini"
  }
}
```

#### 示例 2: 代码助手专家路由(混合虚拟和实际模型)

```json
{
  "id": "expert-routing-2",
  "name": "代码助手专家路由",
  "description": "根据任务类型选择专家模型",
  "enabled": true,
  "classifier": {
    "type": "virtual",
    "model_id": "classifier-virtual-model",
    "prompt_template": "分析用户请求的类型,分类为: code_generation(代码生成)、code_review(代码审查)、documentation(文档编写)、debugging(调试帮助)、general(一般问题)。只返回分类结果。\n\n用户请求: {{user_prompt}}",
    "max_tokens": 20,
    "temperature": 0.0
  },
  "experts": [
    {
      "id": "expert-1",
      "category": "code_generation",
      "type": "virtual",
      "model_id": "code-gen-virtual-model",
      "description": "代码生成专家(带负载均衡)",
      "priority": 1,
      "color": "#52c41a"
    },
    {
      "id": "expert-2",
      "category": "code_review",
      "type": "real",
      "provider_id": "openai-provider",
      "model": "gpt-4o",
      "description": "代码审查专家",
      "priority": 2,
      "color": "#1890ff"
    },
    {
      "id": "expert-3",
      "category": "documentation",
      "type": "real",
      "provider_id": "openai-provider",
      "model": "gpt-4o-mini",
      "description": "文档编写专家",
      "priority": 3,
      "color": "#faad14"
    }
  ],
  "fallback": {
    "type": "virtual",
    "model_id": "fallback-virtual-model"
  }
}
```

### 3.5 API 接口设计

新增专家路由管理接口:

```typescript
// 获取所有专家路由配置
GET /api/admin/expert-routing

// 创建专家路由配置
POST /api/admin/expert-routing
{
  "name": "配置名称",
  "description": "配置描述",
  "enabled": true,
  "config": { /* ExpertRoutingConfig */ }
}

// 更新专家路由配置
PUT /api/admin/expert-routing/:id
{
  "name": "新名称",
  "config": { /* ExpertRoutingConfig */ }
}

// 删除专家路由配置
DELETE /api/admin/expert-routing/:id

// 获取专家路由统计信息
GET /api/admin/expert-routing/:id/statistics
{
  "totalRequests": 1000,
  "avgClassificationTime": 1200,
  "categoryDistribution": {
    "simple": 450,
    "medium": 350,
    "complex": 200
  }
}

// 获取专家路由日志
GET /api/admin/expert-routing/:id/logs
?page=1&pageSize=50&category=simple

// 关联模型到专家路由
POST /api/admin/expert-routing/:id/models
{
  "modelIds": ["model-1", "model-2"]
}

// 取消模型关联
DELETE /api/admin/expert-routing/:id/models/:modelId
```

## 4. 请求处理流程

### 4.1 完整流程图

```
1. 请求到达 → 虚拟密钥认证
   ↓
2. 检查虚拟密钥关联的模型
   ↓
3. 检查模型配置
   ↓
   ├─ 是否启用专家路由? (expert_routing_id != null)
   │   │
   │   ├─ 是 → [新增] 专家路由流程
   │   │   ↓
   │   │   4. 获取专家路由配置
   │   │   ↓
   │   │   5. 检查配置是否启用
   │   │   ↓
   │   │   6. 提取用户消息内容
   │   │   ↓
   │   │   7. 解析分类器配置
   │   │   ├─ 虚拟模型 → 获取虚拟模型配置
   │   │   └─ 实际模型 → 获取 Provider 配置
   │   │   ↓
   │   │   8. 构造分类请求
   │   │   ↓
   │   │   9. 调用分类模型 API
   │   │   ↓
   │   │   10. 解析分类结果
   │   │   ↓
   │   │   11. 根据分类结果选择专家模型(精确匹配)
   │   │   ├─ 匹配成功 → 使用匹配的专家
   │   │   └─ 匹配失败 → 使用降级策略
   │   │   ↓
   │   │   12. 解析专家模型
   │   │   ├─ 虚拟模型 → 获取虚拟模型配置(继续智能路由)
   │   │   └─ 实际模型 → 获取 Provider 配置
   │   │   ↓
   │   │   13. 更新请求上下文
   │   │   ↓
   │   │   14. 记录专家路由日志
   │   │   ↓
   │   │   15. 继续后续流程
   │   │
   │   └─ 否 → 检查是否为虚拟模型
   │       ├─ 是 (is_virtual = 1) → 智能路由流程
   │       │   ├─ loadbalance → 负载均衡
   │       │   └─ fallback → 故障转移
   │       └─ 否 → 实际模型直接转发
   ↓
16. Provider 解析
   ↓
17. Portkey Gateway 选择
   ↓
18. 请求转发
   ↓
19. 返回响应
```

### 4.2 关键代码集成点

#### 4.2.1 在 `src/routes/proxy.ts` 中集成

在现有的 `resolveProviderFromModel` 函数中添加专家路由逻辑:

```typescript
async function resolveProviderFromModel(
  model: any,
  request: ProxyRequest
): Promise<ResolveProviderResult> {
  // [新增] 优先检查专家路由
  if (model.expert_routing_id) {
    const expertRoutingResult = await resolveExpertRouting(model, request);
    if (expertRoutingResult) {
      return expertRoutingResult;
    }
  }

  // 现有的智能路由逻辑(虚拟模型)
  if (model.is_virtual === 1 && model.routing_config_id) {
    const smartRoutingResult = await resolveSmartRouting(model);
    if (smartRoutingResult) {
      return smartRoutingResult;
    }
  }

  // 现有的普通模型逻辑
  if (!model.provider_id) {
    throw new Error('Model has no provider configured');
  }

  const provider = providerDb.getById(model.provider_id);
  if (!provider) {
    throw new Error('Provider not found');
  }

  return {
    provider,
    providerId: model.provider_id
  };
}
```

#### 4.2.2 新增专家路由解析函数

```typescript
async function resolveExpertRouting(
  model: any,
  request: ProxyRequest
): Promise<ResolveProviderResult | null> {
  if (!model.expert_routing_id) {
    return null;
  }

  const expertRoutingConfig = expertRoutingConfigDb.getById(model.expert_routing_id);
  if (!expertRoutingConfig || !expertRoutingConfig.enabled) {
    memoryLogger.warn(
      `专家路由配置未找到或未启用: ${model.expert_routing_id}`,
      'ExpertRouter'
    );
    return null;
  }

  try {
    const config: ExpertRoutingConfig = JSON.parse(expertRoutingConfig.config);

    // 调用专家路由服务
    const result = await expertRouter.route(request, model.expert_routing_id, {
      modelId: model.id,
      virtualKeyId: request.virtualKeyId
    });

    memoryLogger.info(
      `专家路由: 分类=${result.category} | 专家类型=${result.expertType} | 专家=${result.expertName} | 缓存=${result.cacheHit ? '命中' : '未命中'}`,
      'ExpertRouter'
    );

    // 如果专家是虚拟模型,需要继续解析虚拟模型的路由配置
    if (result.expertType === 'virtual') {
      const virtualModel = modelDb.getById(result.expertModelId);
      if (!virtualModel) {
        throw new Error(`Virtual model not found: ${result.expertModelId}`);
      }

      // 递归解析虚拟模型(可能有智能路由配置)
      return await resolveProviderFromModel(virtualModel, request);
    }

    // 实际模型直接返回 Provider
    return {
      provider: result.provider,
      providerId: result.providerId,
      modelOverride: result.modelOverride
    };

  } catch (e: any) {
    memoryLogger.error(`专家路由失败: ${e.message}`, 'ExpertRouter');

    // 使用降级策略
    if (config.fallback) {
      return await resolveFallbackModel(config.fallback);
    }

    throw new Error(`Expert routing failed: ${e.message}`);
  }
}

async function resolveFallbackModel(
  fallback: FallbackConfig
): Promise<ResolveProviderResult | null> {
  if (fallback.type === 'virtual') {
    const virtualModel = modelDb.getById(fallback.model_id);
    if (virtualModel) {
      return await resolveProviderFromModel(virtualModel, request);
    }
  } else {
    const provider = providerDb.getById(fallback.provider_id);
    if (provider) {
      return {
        provider,
        providerId: fallback.provider_id,
        modelOverride: fallback.model
      };
    }
  }

  return null;
}
```

## 5. 核心组件实现

### 5.1 ExpertRouter 服务实现要点

```typescript
// src/services/expert-router.ts

export class ExpertRouter {
  async route(
    request: ProxyRequest,
    config: ExpertRoutingConfig,
    context: RoutingContext
  ): Promise<ExpertRoutingResult> {
    const startTime = Date.now();

    // 1. 提取用户消息
    const messages = request.body?.messages || [];
    if (messages.length === 0) {
      throw new Error('No messages in request');
    }

    // 2. 调用分类模型
    const category = await this.classify(messages, config.classifier);

    // 3. 选择专家(精确匹配)
    const expert = this.selectExpert(category, config.experts);
    if (!expert) {
      memoryLogger.warn(
        `未找到匹配的专家: 分类结果="${category}"`,
        'ExpertRouter'
      );
      throw new Error(`No expert found for category: ${category}`);
    }

    // 4. 获取 Provider
    const provider = providerDb.getById(expert.provider_id);
    if (!provider) {
      throw new Error(`Expert provider not found: ${expert.provider_id}`);
    }

    // 5. 记录日志
    const classificationTime = Date.now() - startTime;
    await this.logRouting(context, config, category, expert, classificationTime);

    return {
      provider,
      providerId: expert.provider_id,
      modelOverride: expert.model,
      category,
      expert,
      classificationTime
    };
  }

  private async classify(
    messages: ChatMessage[],
    classifierConfig: ClassifierConfig
  ): Promise<string> {
    // 1. 提取最后一条用户消息
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();

    if (!lastUserMessage) {
      throw new Error('No user message found for classification');
    }

    const userPrompt = typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content);

    // 2. 构造分类请求
    const classificationPrompt = classifierConfig.prompt_template
      .replace('{{user_prompt}}', userPrompt);

    const classificationRequest = {
      model: classifierConfig.model,
      messages: [
        { role: 'user', content: classificationPrompt }
      ],
      max_tokens: classifierConfig.max_tokens || 50,
      temperature: classifierConfig.temperature ?? 0.0
    };

    // 3. 调用分类模型
    const provider = providerDb.getById(classifierConfig.provider_id);
    if (!provider) {
      throw new Error(`Classifier provider not found: ${classifierConfig.provider_id}`);
    }

    const apiKey = decryptApiKey(provider.api_key);
    const endpoint = buildChatCompletionsEndpoint(provider.base_url);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(classificationRequest),
      signal: AbortSignal.timeout(classifierConfig.timeout || 10000)
    });

    if (!response.ok) {
      throw new Error(`Classification failed: HTTP ${response.status}`);
    }

    const result = await response.json();

    // 4. 解析分类结果
    const category = result.choices?.[0]?.message?.content?.trim();
    if (!category) {
      throw new Error('Empty classification result');
    }

    memoryLogger.debug(
      `分类完成: ${category} | 模型: ${classifierConfig.model}`,
      'ExpertRouter'
    );

    return category;
  }

  private selectExpert(
    category: string,
    experts: ExpertTarget[]
  ): ExpertTarget | null {
    // 精确匹配(完全一致)
    const exactMatch = experts.find(
      e => e.category === category
    );

    if (exactMatch) {
      memoryLogger.debug(
        `专家匹配成功: 分类="${category}" → 专家="${exactMatch.category}"`,
        'ExpertRouter'
      );
      return exactMatch;
    }

    // 未找到匹配的专家
    return null;
  }

  private async logRouting(
    context: RoutingContext,
    config: ExpertRoutingConfig,
    category: string,
    expert: ExpertTarget,
    classificationTime: number
  ): Promise<void> {
    try {
      await expertRoutingLogDb.create({
        id: nanoid(),
        virtual_key_id: context.virtualKeyId || null,
        routing_config_id: context.routingConfigId,
        request_hash: context.requestHash,
        classifier_model: config.classifier.model,
        classification_result: category,
        selected_expert: `${expert.provider_id}/${expert.model || 'default'}`,
        classification_time: classificationTime
      });
    } catch (error: any) {
      memoryLogger.error(
        `记录专家路由日志失败: ${error.message}`,
        'ExpertRouter'
      );
    }
  }
}

export const expertRouter = new ExpertRouter();
```

### 5.2 数据库操作层

```typescript
// src/db/index.ts 中新增

export const expertRoutingLogDb = {
  async create(log: Omit<ExpertRoutingLog, 'created_at'>): Promise<void> {
    const now = Date.now();
    db.run(
      `INSERT INTO expert_routing_logs (
        id, virtual_key_id, routing_config_id, request_hash,
        classifier_model, classification_result, selected_expert,
        classification_time, cache_hit, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.id,
        log.virtual_key_id,
        log.routing_config_id,
        log.request_hash,
        log.classifier_model,
        log.classification_result,
        log.selected_expert,
        log.classification_time,
        log.cache_hit,
        now
      ]
    );
    markDirty();
  },

  getByConfigId(configId: string, limit: number = 100): ExpertRoutingLog[] {
    const result = db.exec(
      `SELECT * FROM expert_routing_logs
       WHERE routing_config_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [configId, limit]
    );
    // ... 解析结果
  },

  getStatistics(configId: string, timeRange: number): RoutingStatistics {
    // 统计分类分布、缓存命中率等
  }
};
```

## 6. 前端界面设计

### 6.1 菜单结构调整

在 `web/src/layouts/MainLayout.vue` 中的"实验性功能"分组下新增专家路由菜单项:

```typescript
{
  label: t('menu.experimentalFeatures'),
  key: 'experimental-features',
  icon: () => h(NIcon, null, { default: () => h(FlaskOutline) }),
  children: [
    {
      label: t('menu.promptManagement'),
      key: 'prompt-management',
      icon: () => h(NIcon, null, { default: () => h(ChatbubbleEllipsesOutline) }),
    },
    {
      label: t('menu.expertRouting'),  // 新增
      key: 'expert-routing',
      icon: () => h(NIcon, null, { default: () => h(GitBranchOutline) }),
    },
  ],
}
```

### 6.2 专家路由主页面

新增 `web/src/views/ExpertRoutingView.vue`:

```vue
<template>
  <div>
    <n-space vertical :size="12">
      <!-- 页面标题 -->
      <n-space justify="space-between" align="center">
        <div>
          <h2 class="page-title">专家路由</h2>
          <p class="page-subtitle">
            通过分类模型智能识别请求类型,将请求路由到专门的专家模型
          </p>
        </div>
        <n-space :size="8">
          <n-button type="primary" size="small" @click="handleCreate">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            创建专家路由
          </n-button>
          <n-button size="small" @click="handleRefresh">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            刷新
          </n-button>
        </n-space>
      </n-space>

      <!-- 功能说明 -->
      <n-alert type="info" closable>
        <template #header>实验性功能</template>
        专家路由是一个实验性功能,支持虚拟模型和实际模型作为分类器和专家。
        配置后,可以在模型管理页面将模型关联到专家路由配置。
      </n-alert>

      <!-- 配置列表 -->
      <n-card class="table-card">
        <n-data-table
          :columns="columns"
          :data="configs"
          :loading="loading"
          :pagination="{ pageSize: 10 }"
          :bordered="false"
          size="small"
        />
      </n-card>
    </n-space>

    <!-- 配置编辑器模态框 -->
    <n-modal
      v-model:show="showEditorModal"
      preset="card"
      :title="editingId ? '编辑专家路由' : '创建专家路由'"
      style="width: 90%; max-width: 1200px"
      :segmented="{ content: 'soft' }"
    >
      <ExpertRoutingEditor
        v-model:config="editingConfig"
        :provider-options="providerOptions"
        :model-options="modelOptions"
        @save="handleSave"
        @cancel="handleCancel"
        :saving="saving"
      />
    </n-modal>

    <!-- 可视化预览模态框 -->
    <n-modal
      v-model:show="showVisualizationModal"
      preset="card"
      title="路由可视化"
      style="width: 90%; max-width: 1400px"
    >
      <ExpertRoutingVisualization :config="previewConfig" />
    </n-modal>

    <!-- 统计信息模态框 -->
    <n-modal
      v-model:show="showStatisticsModal"
      preset="card"
      title="路由统计"
      style="width: 800px"
    >
      <ExpertRoutingStatistics :config-id="selectedConfigId" />
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted } from 'vue';
import {
  useMessage,
  NSpace,
  NCard,
  NButton,
  NIcon,
  NDataTable,
  NModal,
  NAlert,
  NTag,
  NSwitch,
  NPopconfirm,
} from 'naive-ui';
import {
  AddOutline,
  RefreshOutline,
  GitBranchOutline,
} from '@vicons/ionicons5';
import {
  EditOutlined,
  DeleteOutlined,
  VisibilityOutlined,
  BarChartOutlined,
} from '@vicons/material';
import { expertRoutingApi } from '@/api/expert-routing';
import ExpertRoutingEditor from '@/components/ExpertRoutingEditor.vue';
import ExpertRoutingVisualization from '@/components/ExpertRoutingVisualization.vue';
import ExpertRoutingStatistics from '@/components/ExpertRoutingStatistics.vue';

// 组件逻辑...
</script>
```

### 6.3 可视化编辑器组件

新增 `web/src/components/ExpertRoutingEditor.vue`:

```vue
<template>
  <n-steps :current="currentStep" :status="currentStatus">
    <n-step title="基本信息" />
    <n-step title="分类器配置" />
    <n-step title="专家配置" />
    <n-step title="降级策略" />
    <n-step title="关联模型" />
  </n-steps>

  <div class="step-content">
    <!-- 步骤 1: 基本信息 -->
    <div v-show="currentStep === 1">
      <n-form :model="formValue" label-placement="left" :label-width="120">
        <n-form-item label="配置名称" required>
          <n-input v-model:value="formValue.name" placeholder="例如: 客服专家路由" />
        </n-form-item>
        <n-form-item label="配置描述">
          <n-input
            v-model:value="formValue.description"
            type="textarea"
            :rows="3"
            placeholder="描述此专家路由的用途"
          />
        </n-form-item>
        <n-form-item label="是否启用">
          <n-switch v-model:value="formValue.enabled" />
        </n-form-item>
      </n-form>
    </div>

    <!-- 步骤 2: 分类器配置 -->
    <div v-show="currentStep === 2">
      <n-form :model="formValue.classifier" label-placement="left" :label-width="120">
        <n-form-item label="模型类型" required>
          <n-radio-group v-model:value="formValue.classifier.type">
            <n-radio value="virtual">虚拟模型</n-radio>
            <n-radio value="real">实际模型</n-radio>
          </n-radio-group>
        </n-form-item>

        <!-- 虚拟模型选择 -->
        <n-form-item
          v-if="formValue.classifier.type === 'virtual'"
          label="虚拟模型"
          required
        >
          <n-select
            v-model:value="formValue.classifier.model_id"
            :options="virtualModelOptions"
            placeholder="选择虚拟模型"
          />
        </n-form-item>

        <!-- 实际模型选择 -->
        <template v-else>
          <n-form-item label="Provider" required>
            <n-select
              v-model:value="formValue.classifier.provider_id"
              :options="providerOptions"
              placeholder="选择 Provider"
            />
          </n-form-item>
          <n-form-item label="模型名称" required>
            <n-input
              v-model:value="formValue.classifier.model"
              placeholder="例如: gpt-4o-mini"
            />
          </n-form-item>
        </template>

        <n-form-item label="分类提示词" required>
          <n-input
            v-model:value="formValue.classifier.prompt_template"
            type="textarea"
            :rows="6"
            placeholder="使用 {{user_prompt}} 作为用户输入的占位符"
          />
          <template #feedback>
            <n-text depth="3" style="font-size: 12px">
              提示: 使用 {{user_prompt}} 占位符表示用户输入内容
            </n-text>
          </template>
        </n-form-item>

        <n-grid :cols="2" :x-gap="12">
          <n-gi>
            <n-form-item label="Max Tokens">
              <n-input-number
                v-model:value="formValue.classifier.max_tokens"
                :min="1"
                :max="1000"
                style="width: 100%"
              />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="Temperature">
              <n-input-number
                v-model:value="formValue.classifier.temperature"
                :min="0"
                :max="2"
                :step="0.1"
                style="width: 100%"
              />
            </n-form-item>
          </n-gi>
        </n-grid>

        <n-form-item label="超时时间(ms)">
          <n-input-number
            v-model:value="formValue.classifier.timeout"
            :min="1000"
            :max="60000"
            :step="1000"
            style="width: 100%"
          />
        </n-form-item>
      </n-form>
    </div>

    <!-- 步骤 3: 专家配置(可视化) -->
    <div v-show="currentStep === 3">
      <ExpertRoutingVisualization
        v-model:experts="formValue.experts"
        :classifier-config="formValue.classifier"
        :provider-options="providerOptions"
        :model-options="modelOptions"
      />
    </div>

    <!-- 其他步骤... -->
  </div>

  <!-- 底部按钮 -->
  <template #footer>
    <n-space justify="space-between">
      <n-button @click="handlePrevious" :disabled="currentStep === 1">
        上一步
      </n-button>
      <n-space>
        <n-button @click="$emit('cancel')">取消</n-button>
        <n-button
          v-if="currentStep < 5"
          type="primary"
          @click="handleNext"
        >
          下一步
        </n-button>
        <n-button
          v-else
          type="primary"
          @click="handleSave"
          :loading="saving"
        >
          保存配置
        </n-button>
      </n-space>
    </n-space>
  </template>
</template>
```

### 6.4 可视化展示组件

新增 `web/src/components/ExpertRoutingVisualization.vue`:

```vue
<template>
  <div class="expert-routing-visualization">
    <!-- 工具栏 -->
    <div class="toolbar">
      <n-space>
        <n-button size="small" @click="handleAddExpert">
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
          添加专家
        </n-button>
        <n-text depth="3" style="font-size: 12px">
          提示: 点击节点可编辑配置
        </n-text>
      </n-space>
    </div>

    <!-- 可视化展示区域 -->
    <div class="visualization-container">
      <!-- 入口节点 -->
      <div class="node entry-node">
        <div class="node-header">
          <n-icon size="20"><EnterOutline /></n-icon>
          <span>专家路由入口</span>
        </div>
        <div class="node-body">
          <n-text depth="3" style="font-size: 12px">
            请求进入专家路由
          </n-text>
        </div>
      </div>

      <!-- 箭头 -->
      <div class="arrow">→</div>

      <!-- 分类器节点 -->
      <div class="node classifier-node" @click="handleEditClassifier">
        <div class="node-header">
          <n-icon size="20"><FilterOutline /></n-icon>
          <span>分类器</span>
        </div>
        <div class="node-body">
          <n-text depth="3" style="font-size: 12px">
            {{ classifierLabel }}
          </n-text>
          <n-tag size="tiny" :type="classifierConfig.type === 'virtual' ? 'info' : 'success'">
            {{ classifierConfig.type === 'virtual' ? '虚拟模型' : '实际模型' }}
          </n-tag>
        </div>
      </div>

      <!-- 箭头 -->
      <div class="arrow">→</div>

      <!-- 专家节点列表 -->
      <div class="experts-container">
        <div
          v-for="(expert, index) in experts"
          :key="expert.id"
          class="expert-item"
        >
          <div class="node expert-node" @click="handleEditExpert(expert)">
            <div class="node-header" :style="{ backgroundColor: expert.color || '#f0f0f0' }">
              <n-icon size="18"><CubeOutline /></n-icon>
              <span>{{ expert.category }}</span>
              <n-button
                text
                size="tiny"
                @click.stop="handleDeleteExpert(expert.id)"
              >
                <template #icon>
                  <n-icon><CloseOutline /></n-icon>
                </template>
              </n-button>
            </div>
            <div class="node-body">
              <n-text depth="3" style="font-size: 12px">
                {{ getExpertLabel(expert) }}
              </n-text>
              <n-tag size="tiny" :type="expert.type === 'virtual' ? 'info' : 'success'">
                {{ expert.type === 'virtual' ? '虚拟模型' : '实际模型' }}
              </n-tag>
            </div>
          </div>
          <div v-if="index < experts.length - 1" class="expert-divider">
            <n-divider style="margin: 8px 0" />
          </div>
        </div>

        <!-- 空状态 -->
        <n-empty
          v-if="experts.length === 0"
          description="暂无专家配置"
          size="small"
          style="padding: 20px"
        >
          <template #extra>
            <n-button size="small" @click="handleAddExpert">
              添加第一个专家
            </n-button>
          </template>
        </n-empty>
      </div>
    </div>

    <!-- 专家编辑抽屉 -->
    <n-drawer v-model:show="showExpertDrawer" :width="400">
      <n-drawer-content title="编辑专家">
        <ExpertForm
          v-model:expert="editingExpert"
          :provider-options="providerOptions"
          :model-options="modelOptions"
          @save="handleSaveExpert"
        />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.expert-routing-visualization {
  min-height: 400px;
  display: flex;
  flex-direction: column;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  background-color: #fafafa;
}

.toolbar {
  padding: 12px;
  border-bottom: 1px solid #e0e0e0;
  background-color: #fff;
}

.visualization-container {
  flex: 1;
  padding: 24px;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  overflow-x: auto;
}

.node {
  width: 180px;
  background-color: #fff;
  border: 2px solid #d9d9d9;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  transition: all 0.3s;
  flex-shrink: 0;
}

.node:hover {
  border-color: #40a9ff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.node-header {
  padding: 8px 12px;
  background-color: #f0f0f0;
  border-bottom: 1px solid #d9d9d9;
  border-radius: 6px 6px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.node-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.entry-node {
  border-color: #52c41a;
  cursor: default;
}

.entry-node:hover {
  border-color: #52c41a;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.classifier-node {
  border-color: #1890ff;
}

.arrow {
  font-size: 24px;
  color: #999;
  display: flex;
  align-items: center;
  padding-top: 40px;
  flex-shrink: 0;
}

.experts-container {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex-shrink: 0;
}

.expert-item {
  display: flex;
  flex-direction: column;
}

.expert-divider {
  width: 100%;
}
</style>
```

## 7. 技术挑战与解决方案

### 7.1 挑战 1: 分类延迟影响用户体验

**问题**: 每次请求都需要先调用分类模型,增加了额外的延迟。

**解决方案**:
1. **智能缓存**: 基于请求内容的哈希值缓存分类结果,相似请求直接使用缓存
2. **轻量级分类器**: 推荐使用快速模型(如 gpt-4o-mini)作为分类器
3. **超时控制**: 设置合理的分类超时时间(建议 5-10 秒),超时自动降级
4. **异步预热**: 对于高频请求模式,可以预先进行分类并缓存

### 7.2 挑战 2: 分类准确性

**问题**: 分类模型可能出现误判,导致请求被路由到错误的专家。

**解决方案**:
1. **精心设计提示词**: 提供清晰的分类标准和示例
2. **模糊匹配机制**: 当精确匹配失败时,使用模糊匹配或默认专家
3. **降级策略**: 配置可靠的降级模型,确保服务可用性
4. **监控和反馈**: 记录所有路由决策,便于分析和优化
5. **A/B 测试**: 支持多个分类策略并行测试,选择最优方案

### 7.3 挑战 3: 成本控制

**问题**: 每次请求都调用分类模型会增加 API 调用成本。

**解决方案**:
1. **高效缓存**: 合理设置缓存 TTL,减少重复分类
2. **批量分类**: 对于批量请求,可以考虑批量分类(需要 API 支持)
3. **成本监控**: 在日志中记录分类成本,便于分析
4. **可选功能**: 专家路由作为可选功能,用户可以根据需求启用

### 7.4 挑战 4: 与现有路由机制的兼容性

**问题**: 需要与现有的负载均衡、故障转移、Portkey Gateway 路由等机制协同工作。

**解决方案**:
1. **分层设计**: 专家路由在模型层面工作,Portkey Gateway 路由在网关层面工作,互不冲突
2. **统一接口**: 专家路由返回标准的 `ResolveProviderResult`,与现有逻辑无缝集成
3. **优先级明确**: 专家路由 > 智能路由 > 普通模型,按优先级依次检查
4. **降级兼容**: 当专家路由失败时,自动回退到现有路由机制

### 7.5 挑战 5: 流式响应处理

**问题**: 分类需要在流式响应开始前完成,可能影响首字节时间。

**解决方案**:
1. **快速分类**: 使用低延迟的分类模型,控制分类时间在 1-2 秒内
2. **缓存优先**: 对于缓存命中的请求,几乎无额外延迟
3. **并行优化**: 在分类的同时预加载 Provider 配置,减少总延迟
4. **用户感知**: 在响应头中添加 `X-Expert-Routing` 信息,让用户了解路由过程

### 7.6 挑战 6: 多轮对话上下文

**问题**: 在多轮对话中,每轮都重新分类可能不一致。

**解决方案**:
1. **会话级缓存**: 基于会话 ID 缓存分类结果,同一会话使用相同专家
2. **上下文感知**: 分类时考虑完整的对话历史,而不仅仅是最后一条消息
3. **用户控制**: 允许用户在请求中指定专家类别,跳过分类步骤
4. **智能切换**: 检测话题转换,必要时重新分类

## 8. 实施计划

### 8.1 第一阶段:数据库和后端核心

- [ ] 数据库迁移
  - [ ] 创建 `expert_routing_configs` 表
  - [ ] 创建 `expert_routing_logs` 表
  - [ ] 扩展 `models` 表,新增 `expert_routing_id` 字段
  - [ ] 添加必要的索引和外键约束
- [ ] 后端 API 实现
  - [ ] 专家路由配置 CRUD 接口
  - [ ] 统计信息查询接口
  - [ ] 日志查询接口
  - [ ] 模型关联接口
- [ ] `ExpertRouter` 服务实现
  - [ ] 分类模型调用(支持虚拟模型和实际模型)
  - [ ] 专家选择逻辑(精确匹配、模糊匹配、降级)
  - [ ] 专家模型解析(虚拟模型递归解析)
  - [ ] 基本的错误处理
- [ ] 集成到请求处理流程
  - [ ] 修改 `resolveProviderFromModel` 函数
  - [ ] 实现 `resolveExpertRouting` 函数
  - [ ] 实现降级策略

### 8.2 第二阶段:缓存和优化

- [ ] 分类结果缓存实现
  - [ ] 基于内容的缓存键生成
  - [ ] 基于会话的缓存策略
  - [ ] 缓存过期和清理机制
- [ ] 性能优化
  - [ ] 分类请求超时控制
  - [ ] 并行请求优化
  - [ ] 重试机制
- [ ] 日志记录
  - [ ] 详细的路由日志
  - [ ] 性能指标记录
  - [ ] 错误日志

### 8.3 第三阶段:前端界面

- [ ] 菜单和路由
  - [ ] 在"实验性功能"下新增"专家路由"菜单项
  - [ ] 添加路由配置
  - [ ] 国际化文本
- [ ] 主页面实现
  - [ ] 配置列表展示
  - [ ] 启用/禁用开关
  - [ ] 编辑、删除、复制操作
  - [ ] 统计信息展示
- [ ] 配置编辑器
  - [ ] 多步骤向导
  - [ ] 基本信息表单
  - [ ] 分类器配置表单(支持虚拟/实际模型)
  - [ ] 降级策略配置
  - [ ] 模型关联选择
- [ ] 可视化画布
  - [ ] 节点渲染(分类器、专家)
  - [ ] 连接线绘制
  - [ ] 拖拽和缩放
  - [ ] 节点编辑
  - [ ] 自动布局
- [ ] 统计和监控
  - [ ] 统计图表(分类分布、缓存命中率)
  - [ ] 日志查看器
  - [ ] 实时监控

### 8.4 第四阶段:测试和文档

- [ ] 单元测试
  - [ ] ExpertRouter 服务测试
  - [ ] 分类逻辑测试
  - [ ] 专家选择测试
  - [ ] 缓存机制测试
- [ ] 集成测试
  - [ ] 端到端请求测试
  - [ ] 虚拟模型递归解析测试
  - [ ] 降级策略测试
- [ ] 性能测试
  - [ ] 分类延迟测试
  - [ ] 缓存命中率测试
  - [ ] 并发请求测试
- [ ] 文档编写
  - [ ] 用户使用指南
  - [ ] API 文档
  - [ ] 配置示例
  - [ ] 最佳实践
  - [ ] 故障排查指南

## 9. 测试策略

### 9.1 单元测试

```typescript
describe('ExpertRouter', () => {
  it('should classify request correctly', async () => {
    const result = await expertRouter.classify(messages, classifierConfig);
    expect(result).toBe('complex');
  });

  it('should select expert by category', () => {
    const expert = expertRouter.selectExpert('simple', experts);
    expect(expert.provider_id).toBe('deepseek-provider');
  });

  it('should use exact matching for expert selection', () => {
    const expert = expertRouter.selectExpert('simple', experts);
    expect(expert).toBeDefined();
    expect(expert.category).toBe('simple');
  });

  it('should return null when no exact match found', () => {
    const expert = expertRouter.selectExpert('unknown', experts);
    expect(expert).toBeNull();
  });
});
```

### 9.2 集成测试

```typescript
describe('Expert Routing Integration', () => {
  it('should route request through expert routing', async () => {
    const response = await fetch('http://localhost:3000/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer expert-routing-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'expert-model',
        messages: [{ role: 'user', content: 'Simple question' }]
      })
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get('X-Expert-Category')).toBe('simple');
  });
});
```

### 9.3 性能测试

- 测试分类延迟(目标: < 2 秒)
- 测试并发请求处理能力
- 测试降级机制的响应时间
- 测试精确匹配的准确性

## 10. 监控指标

### 10.1 关键指标

- **分类准确率**: 通过人工标注样本评估
- **分类延迟**: P50, P95, P99 延迟
- **匹配成功率**: 精确匹配成功次数 / 总请求次数
- **降级率**: 降级次数 / 总请求次数
- **专家分布**: 各专家处理的请求占比
- **成本分析**: 分类调用成本 vs 专家调用成本

### 10.2 告警规则

- 分类失败率 > 5%
- 平均分类延迟 > 5 秒
- 匹配失败率 > 10%
- 降级率 > 15%

## 11. 最佳实践建议

### 11.1 分类器选择

- **推荐模型**: gpt-4o-mini, claude-3-haiku(快速且成本低)
- **避免使用**: 大型模型作为分类器(成本高、延迟大)
- **提示词设计**: 简洁明确,包含分类标准和示例

### 11.2 专家配置

- **专家数量**: 建议 3-5 个专家,过多会增加分类难度
- **类别命名**: 使用简短、明确的类别名称
- **降级策略**: 必须配置可靠的降级模型

### 11.3 监控和优化

- **定期审查**: 每周查看路由日志,分析分类准确性
- **A/B 测试**: 测试不同的分类策略和提示词
- **成本优化**: 根据实际使用情况调整专家配置

## 12. 总结

专家路由作为 LLM Gateway 的实验性功能,通过分类模型智能识别请求类型,将请求路由到专门的专家模型,实现了任务专业化和成本优化。该设计采用简化的实现方案,降低初期开发复杂度,同时保留核心功能和扩展性。

### 12.1 核心特性

1. **实验性功能定位**: 作为独立的实验性功能,与 Prompt 管理并列,不影响现有功能
2. **后端灵活性**: 支持虚拟模型和实际模型作为分类器和专家,充分利用现有资源
3. **可视化展示**: 使用流程图样式静态展示路由逻辑,直观易懂
4. **独立配置页**: 功能完善的专门配置界面,包含多步骤向导
5. **架构兼容**: 与现有的智能路由(负载均衡/故障转移)并行工作,互不冲突
6. **简化实现**: 移除缓存和复杂匹配逻辑,降低初期开发复杂度

### 12.2 主要优势

1. **灵活的模型选择**:
   - 分类器可以是虚拟模型(带智能路由)或实际模型
   - 专家可以是虚拟模型(带智能路由)或实际模型
   - 支持混合配置,充分利用现有资源

2. **递归路由支持**:
   - 专家为虚拟模型时,自动继续解析其智能路由配置
   - 支持多层路由嵌套,实现复杂的路由策略

3. **简洁的匹配机制**:
   - 精确匹配专家类别
   - 匹配失败时使用降级策略
   - 简单可靠,易于理解和维护

4. **可视化配置体验**:
   - 流程图样式展示路由逻辑
   - 静态展示,点击编辑
   - 直观展示路由流程

5. **完善的监控体系**:
   - 详细的路由日志
   - 统计图表(分类分布、匹配成功率、平均耗时)
   - 实时监控和告警

### 12.3 适用场景

- **客服系统**: 根据问题复杂度路由到不同级别的模型
- **代码助手**: 根据任务类型(生成、审查、调试)选择专家模型
- **多语言应用**: 根据语言类型路由到对应的语言专家
- **领域专家**: 医疗、法律、金融等垂直领域的专业化处理
- **成本优化**: 简单任务使用经济型模型,复杂任务使用高级模型
- **混合部署**: 结合虚拟模型的智能路由和实际模型的直接调用

### 12.4 技术亮点

1. **独立表设计**: 专家路由配置独立存储,不影响现有路由配置表
2. **字段扩展**: 在 models 表中新增 `expert_routing_id` 字段,与 `routing_config_id` 互斥
3. **优先级明确**: 专家路由 > 智能路由 > 实际模型,按优先级依次检查
4. **递归解析**: 支持虚拟模型的递归解析,实现多层路由嵌套
5. **类型安全**: 完整的 TypeScript 类型定义,确保类型安全
6. **精确匹配**: 简单可靠的精确匹配机制,易于理解和维护
7. **实时分类**: 每次请求实时调用分类模型,确保结果准确性

### 12.5 后续扩展方向

1. **机器学习优化**: 基于历史数据训练更准确的分类模型
2. **动态调整**: 根据负载和成本自动调整专家选择策略
3. **多级分类**: 支持层级化的分类体系,实现更精细的路由
4. **用户反馈**: 收集用户对路由结果的反馈,持续优化分类准确性
5. **预测性路由**: 基于用户画像和历史行为预测最佳专家
6. **A/B 测试**: 支持多个专家路由配置并行测试,选择最优方案
7. **自动优化**: 根据统计数据自动调整分类提示词和专家配置

### 12.6 与现有功能的关系

```
LLM Gateway 功能架构:

├─ 核心功能
│  ├─ Provider 管理
│  ├─ 模型管理
│  ├─ 虚拟密钥管理
│  └─ Portkey Gateway 管理
│
├─ 智能路由(虚拟模型)
│  ├─ 负载均衡
│  └─ 故障转移
│
└─ 实验性功能
   ├─ Prompt 管理
   └─ 专家路由 [新增]
      ├─ 支持虚拟模型作为分类器/专家
      ├─ 支持实际模型作为分类器/专家
      └─ 可与智能路由组合使用
```

**关键点**:
- 专家路由与智能路由是互补关系,不是替代关系
- 专家路由可以使用虚拟模型(带智能路由)作为专家
- 这样可以实现"先分类,再负载均衡"的复杂路由策略

---

**文档版本**: v2.0
**创建日期**: 2025-10-21
**最后更新**: 2025-10-21
**作者**: LLM Gateway Team

**变更记录**:
- v2.0 (2025-10-21): 重新设计为独立的实验性功能,支持虚拟模型和实际模型混合配置
- v1.0 (2025-10-21): 初始版本,作为路由配置的一种类型

