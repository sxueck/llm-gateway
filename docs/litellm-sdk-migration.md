# LiteLLM SDK 迁移方案

## 一、可行性评估

### ✅ 可行性结论：**完全可行**

基于对当前代码库的分析，使用 LiteLLM SDK 替代 Portkey Gateway 是完全可行的，且具有以下优势：

#### 优势分析

1. **更高的自由度**
   - 直接控制 LLM 请求的发送和解析逻辑
   - 无需依赖外部 Gateway 服务
   - 可以自定义请求处理流程

2. **简化架构**
   - 移除 Portkey Gateway 容器依赖
   - 移除 Agent 分布式部署复杂度
   - 减少网络跳转，降低延迟

3. **更好的可维护性**
   - 所有逻辑集中在 Node.js 应用中
   - 更容易调试和排查问题
   - 减少组件间的耦合

4. **成本优化**
   - 减少 Docker 容器资源消耗
   - 简化部署流程
   - 降低运维复杂度

#### 风险评估

1. **低风险**
   - LiteLLM SDK 是成熟的开源项目，社区活跃
   - 支持 20+ 主流 LLM 提供商
   - 与当前项目的功能需求高度匹配

2. **迁移成本可控**
   - 核心业务逻辑（虚拟密钥、路由、缓存等）无需改动
   - 主要改动集中在请求转发层
   - 可以逐步迁移，保持向后兼容

---

## 二、当前架构分析

### 2.1 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                        LLM Gateway                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Virtual Keys │  │   Routing    │  │    Cache     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                          │                                  │
│                          ▼                                  │
│              ┌────────────────────────┐                     │
│              │ Provider Config Builder│                     │
│              └────────────────────────┘                     │
│                          │                                  │
│                          ▼                                  │
│              ┌────────────────────────┐                     │
│              │  Portkey Router        │                     │
│              │  (选择 Gateway)        │                     │
│              └────────────────────────┘                     │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           ▼
              ┌────────────────────────┐
              │   Portkey Gateway      │
              │   (Docker Container)   │
              └────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │   LLM Providers        │
              │ (OpenAI, Anthropic...) │
              └────────────────────────┘
```

### 2.2 关键依赖点

1. **Portkey Gateway 路由** (`src/services/portkey-router.ts`)
   - 根据规则选择 Gateway 实例
   - 支持多 Gateway 负载均衡

2. **Provider Config Builder** (`src/routes/proxy/provider-config-builder.ts`)
   - 构建 Portkey 配置 JSON
   - 设置 `x-portkey-config` 请求头

3. **HTTP Client** (`src/routes/proxy/http-client.ts`)
   - 转发请求到 Portkey Gateway
   - 处理流式和非流式响应

4. **Agent 系统** (`agent/` 目录)
   - Go 语言编写的分布式 Agent
   - 管理远程 Portkey Gateway 容器

---

## 三、目标架构设计

### 3.1 新架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        LLM Gateway                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Virtual Keys │  │   Routing    │  │    Cache     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                          │                                  │
│                          ▼                                  │
│              ┌────────────────────────┐                     │
│              │  LiteLLM SDK Adapter   │                     │
│              │  (直接调用 LLM API)    │                     │
│              └────────────────────────┘                     │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           ▼
              ┌────────────────────────┐
              │   LLM Providers        │
              │ (OpenAI, Anthropic...) │
              └────────────────────────┘
```

### 3.2 核心改动

1. **移除组件**
   - Portkey Gateway 容器
   - Agent 分布式系统
   - Portkey Router 服务
   - Gateway 管理相关路由和数据库表

2. **新增组件**
   - LiteLLM SDK 集成层
   - Provider Adapter（基于 LiteLLM）
   - 统一的请求/响应处理器

3. **保留组件**
   - 虚拟密钥管理
   - 缓存系统
   - Token 计数
   - 请求日志
   - Prompt 处理
   - 专家路由

---

## 四、详细重构步骤

### 阶段一：准备工作（1-2 天）

#### 1.1 安装 LiteLLM SDK

```bash
npm install litellm
```

**注意**：LiteLLM 主要是 Python 库，Node.js 环境需要考虑以下方案：

**方案 A：使用 OpenAI SDK + 自定义适配器**（推荐）
```bash
npm install openai
```
自己实现多提供商适配逻辑，参考 LiteLLM 的映射规则。

**方案 B：通过子进程调用 Python LiteLLM**
```bash
pip install litellm
```
在 Node.js 中通过子进程调用 Python 脚本。

**方案 C：使用现有的 Node.js 多提供商库**
```bash
npm install @anthropic-ai/sdk @google/generative-ai
```
为每个提供商单独集成 SDK。

**推荐方案 A**，因为：
- 性能最优，无跨语言调用开销
- 代码可控性强
- 与现有 TypeScript 代码库无缝集成

#### 1.2 创建 LiteLLM 适配器基础结构

创建 `src/services/litellm-adapter.ts`：

```typescript
import OpenAI from 'openai';

export interface LiteLLMConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class LiteLLMAdapter {
  async chatCompletion(config: LiteLLMConfig, messages: any[], options: any) {
    // 根据 provider 选择对应的 SDK 调用
  }
  
  async streamChatCompletion(config: LiteLLMConfig, messages: any[], options: any) {
    // 流式响应处理
  }
}
```

### 阶段二：核心功能迁移（3-5 天）

#### 2.1 重构 Provider Config Builder

**文件**：`src/routes/proxy/provider-config-builder.ts`

**改动**：
- 移除 Portkey Gateway 选择逻辑
- 移除 `x-portkey-config` 头构建
- 直接返回 Provider 配置供 LiteLLM 使用

```typescript
export async function buildProviderConfig(
  provider: any,
  virtualKey: any,
  virtualKeyValue: string,
  providerId: string,
  request: FastifyRequest
): Promise<LiteLLMConfig | ProviderConfigError> {
  const decryptedApiKey = decryptApiKey(provider.api_key);
  
  return {
    provider: provider.id,
    apiKey: decryptedApiKey,
    baseUrl: provider.base_url,
    model: (request.body as any)?.model || 'unknown'
  };
}
```

#### 2.2 重构 HTTP Client

**文件**：`src/routes/proxy/http-client.ts`

**改动**：
- 移除直接 HTTP 请求逻辑
- 使用 LiteLLM Adapter 调用

```typescript
import { LiteLLMAdapter } from '../services/litellm-adapter.js';

const adapter = new LiteLLMAdapter();

export async function makeHttpRequest(
  config: LiteLLMConfig,
  messages: any[],
  options: any
): Promise<HttpResponse> {
  const response = await adapter.chatCompletion(config, messages, options);
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(response)
  };
}

export async function makeStreamHttpRequest(
  config: LiteLLMConfig,
  messages: any[],
  options: any,
  reply: FastifyReply
): Promise<StreamTokenUsage> {
  return await adapter.streamChatCompletion(config, messages, options, reply);
}
```

#### 2.3 重构 Proxy Handler

**文件**：`src/routes/proxy/proxy-handler.ts`

**改动**：
- 移除 Portkey URL 构建
- 直接调用 LiteLLM Adapter

```typescript
// 原代码
const response = await makeHttpRequest(
  portkeyUrl,
  request.method,
  headers,
  requestBody
);

// 新代码
const litellmConfig = buildResult as LiteLLMConfig;
const response = await makeHttpRequest(
  litellmConfig,
  (request.body as any).messages,
  {
    temperature: (request.body as any).temperature,
    max_tokens: (request.body as any).max_tokens,
    // ... 其他参数
  }
);
```

### 阶段三：数据库清理（1 天）

#### 3.1 移除 Portkey Gateway 相关表

创建迁移脚本 `src/db/migrations.ts`：

```typescript
{
  version: 3,
  name: 'remove_portkey_gateway_tables',
  up: async (conn: Connection) => {
    // 删除路由规则表
    await conn.query('DROP TABLE IF EXISTS model_routing_rules');
    // 删除 Gateway 表
    await conn.query('DROP TABLE IF EXISTS portkey_gateways');
  },
  down: async (conn: Connection) => {
    // 回滚逻辑（重新创建表）
  }
}
```

#### 3.2 移除相关代码文件

删除以下文件：
- `src/routes/portkey-gateways.ts`
- `src/routes/routing-rules.ts`
- `src/routes/agent.ts`
- `src/services/portkey-router.ts`
- `agent/` 整个目录

### 阶段四：前端调整（1-2 天）

#### 4.1 移除 Gateway 管理页面

删除以下文件：
- `web/src/views/PortkeyGateways.vue`
- `web/src/views/RoutingRules.vue`
- `web/src/api/portkey-gateways.ts`

#### 4.2 更新路由配置

**文件**：`web/src/router/index.ts`

移除 Gateway 相关路由。

#### 4.3 更新导航菜单

**文件**：`web/src/components/Layout.vue`

移除 Gateway 管理菜单项。

### 阶段五：测试与优化（2-3 天）

#### 5.1 功能测试清单

- [ ] 虚拟密钥认证
- [ ] 多提供商请求转发
- [ ] 流式响应处理
- [ ] 非流式响应处理
- [ ] Token 计数准确性
- [ ] 缓存功能
- [ ] Prompt 处理
- [ ] 专家路由
- [ ] 错误处理
- [ ] 请求日志记录

#### 5.2 性能测试

- 对比迁移前后的响应延迟
- 测试并发请求处理能力
- 监控内存和 CPU 使用情况

---

## 五、兼容性方案

### 5.1 渐进式迁移

可以通过配置开关实现新旧架构共存：

```typescript
// .env
USE_LITELLM=true  # 启用 LiteLLM，false 则使用 Portkey Gateway
```

在代码中：

```typescript
if (appConfig.useLiteLLM) {
  // 使用 LiteLLM Adapter
} else {
  // 使用 Portkey Gateway
}
```

### 5.2 数据迁移

对于已有的 Gateway 配置，可以提供迁移工具：

```typescript
// scripts/migrate-from-portkey.ts
async function migrateGatewayConfig() {
  // 读取现有 Gateway 配置
  // 转换为新的 Provider 配置
  // 更新数据库
}
```

---

## 六、实施时间表

| 阶段 | 任务 | 预计时间 | 负责人 |
|------|------|----------|--------|
| 1 | 准备工作 | 1-2 天 | 开发 |
| 2 | 核心功能迁移 | 3-5 天 | 开发 |
| 3 | 数据库清理 | 1 天 | 开发 |
| 4 | 前端调整 | 1-2 天 | 前端 |
| 5 | 测试与优化 | 2-3 天 | 测试 |
| **总计** | | **8-13 天** | |

---

## 七、风险控制

### 7.1 回滚方案

1. 保留 Portkey Gateway 相关代码分支
2. 数据库迁移支持回滚
3. 配置开关快速切换

### 7.2 监控指标

- 请求成功率
- 平均响应时间
- 错误率
- Token 计数准确性

---

## 八、后续优化建议

1. **Provider SDK 缓存**
   - 复用 SDK 实例，减少初始化开销

2. **连接池管理**
   - 为每个 Provider 维护 HTTP 连接池

3. **智能重试**
   - 实现指数退避重试策略

4. **请求队列**
   - 实现请求队列和限流机制

5. **监控告警**
   - 集成 Prometheus/Grafana 监控

---

## 九、关键技术实现要点

### 9.1 Provider SDK 选择

由于 LiteLLM 主要是 Python 库，在 Node.js 环境中推荐以下方案：

**推荐方案：使用官方 SDK + 自定义适配器**

```bash
npm install openai @anthropic-ai/sdk @google/generative-ai
```

优势：
- 性能最优，无跨语言调用开销
- 类型安全，完整的 TypeScript 支持
- 代码可控性强，易于调试
- 与现有代码库无缝集成

### 9.2 核心适配器结构

创建 `src/services/litellm-adapter.ts`，实现统一的多提供商接口：

```typescript
export interface LiteLLMConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class LiteLLMAdapter {
  // SDK 实例缓存
  private openaiClients: Map<string, OpenAI> = new Map();
  private anthropicClients: Map<string, Anthropic> = new Map();

  // 统一的聊天补全接口
  async chatCompletion(config: LiteLLMConfig, messages: any[], options: any): Promise<any>

  // 统一的流式聊天补全接口
  async streamChatCompletion(config: LiteLLMConfig, messages: any[], options: any, reply: FastifyReply): Promise<StreamTokenUsage>

  // Provider 标准化
  private normalizeProvider(provider: string): string

  // 格式转换（如 Anthropic <-> OpenAI）
  private convertToAnthropicFormat(messages: any[]): { system?: string; messages: any[] }
  private convertAnthropicToOpenAIFormat(response: any): any
}
```

### 9.3 Provider 映射配置

```typescript
// src/config/provider-mapping.ts
export const PROVIDER_SDK_MAPPING = {
  openai: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  deepseek: 'openai',  // 兼容 OpenAI API
  azure: 'openai',
  google: 'google',
  gemini: 'google',
};
```

### 9.4 关键改动点总结

| 组件 | 原实现 | 新实现 | 改动量 |
|------|--------|--------|--------|
| Provider Config Builder | 构建 Portkey 配置 JSON | 构建 LiteLLM 配置对象 | 中等 |
| HTTP Client | 转发到 Portkey Gateway | 调用 LiteLLM Adapter | 大 |
| Proxy Handler | 使用 Portkey URL | 使用 LiteLLM Config | 中等 |
| 虚拟密钥认证 | 无改动 | 无改动 | 无 |
| 缓存系统 | 无改动 | 无改动 | 无 |
| Token 计数 | 无改动 | 无改动 | 无 |
| Prompt 处理 | 无改动 | 无改动 | 无 |

### 9.5 依赖包更新

**新增依赖**：
```json
{
  "dependencies": {
    "openai": "^4.0.0",
    "@anthropic-ai/sdk": "^0.20.0",
    "@google/generative-ai": "^0.2.0"
  }
}
```

**移除依赖**：
- 无需移除现有依赖，Portkey Gateway 相关逻辑通过代码删除即可

---

## 十、总结

使用 LiteLLM SDK 替代 Portkey Gateway 是一个**可行且推荐**的方案。主要优势包括：

✅ 架构简化，减少组件依赖
✅ 提升性能，减少网络跳转
✅ 增强可控性，便于定制开发
✅ 降低运维成本

建议采用**渐进式迁移**策略，先在测试环境验证，再逐步推广到生产环境。

---

## 附录：完整的 LiteLLM Adapter 示例代码

由于篇幅限制，完整的适配器实现代码请参考项目仓库中的示例文件。

关键实现要点：
1. SDK 实例缓存复用
2. 统一的消息格式转换
3. 流式响应的标准化处理
4. 错误处理和重试机制
5. Token 使用统计

