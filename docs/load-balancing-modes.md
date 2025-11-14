# 负载均衡模式说明

LLM Gateway 现在支持四种负载均衡模式，每种模式适用于不同的场景。

## 模式概览

| 模式 | 适用场景 | 特点 |
|------|---------|------|
| `loadbalance` | 流量均衡分配 | 基于权重的随机分配，每次请求独立选择 |
| `fallback` | 故障转移 | 按顺序轮转，自动切换到下一个可用provider |
| `hash` | 缓存亲和性（用户级） | 基于虚拟密钥或请求特征哈希，相同来源总是路由到相同provider |
| `affinity` | 缓存亲和性（时间窗口） | 在短时间窗口内持续使用同一provider，最大化缓存效益 |

---

## 1. LoadBalance（加权负载均衡）

### 工作原理
- 每次请求根据provider的权重进行**随机**选择
- 权重越高，被选中的概率越大
- 每次请求都是独立的，不保证连续性

### 适用场景
- 流量需要均匀分配到多个provider
- 各provider能力不同，需要按权重分配
- 不依赖缓存或缓存命中率不重要

### 配置示例

```json
{
  "strategy": {
    "mode": "loadbalance"
  },
  "targets": [
    {
      "provider": "provider-a-id",
      "weight": 70,
      "override_params": {
        "model": "gpt-4"
      }
    },
    {
      "provider": "provider-b-id",
      "weight": 30,
      "override_params": {
        "model": "gpt-4"
      }
    }
  ]
}
```

在此配置中：
- Provider A 将收到约70%的流量
- Provider B 将收到约30%的流量

---

## 2. Fallback（故障转移）

### 工作原理
- 按配置顺序轮转使用provider
- 当前provider不可用时，自动切换到下一个
- 使用熔断器保护，避免持续调用失败的provider

### 适用场景
- 需要主备切换
- 希望优先使用某个provider，仅在其不可用时切换
- 成本优化：优先使用便宜的provider

### 配置示例

```json
{
  "strategy": {
    "mode": "fallback"
  },
  "targets": [
    {
      "provider": "primary-provider-id",
      "override_params": {
        "model": "gpt-4"
      }
    },
    {
      "provider": "backup-provider-id",
      "override_params": {
        "model": "gpt-4-turbo"
      }
    }
  ]
}
```

在此配置中：
- 首先使用 primary-provider
- 如果 primary-provider 不可用（熔断），自动切换到 backup-provider

---

## 3. Hash（一致性哈希）🆕

### 工作原理
- 基于指定的哈希源（virtualKey或request）计算哈希值
- 将哈希值映射到某个provider（结合权重）
- **相同的哈希源总是路由到相同的provider**
- 如果该provider不可用，才会fallback到其他provider

### 适用场景
- 需要最大化缓存命中率
- 同一用户/应用的请求希望打到同一个后端
- Provider端有状态或缓存，希望保持会话亲和性

### 配置示例

#### 基于虚拟密钥的哈希（默认）

```json
{
  "strategy": {
    "mode": "hash",
    "hashSource": "virtualKey"
  },
  "targets": [
    {
      "provider": "provider-a-id",
      "weight": 60,
      "override_params": {
        "model": "claude-3-5-sonnet-20250129"
      }
    },
    {
      "provider": "provider-b-id",
      "weight": 40,
      "override_params": {
        "model": "claude-3-5-sonnet-20250129"
      }
    }
  ]
}
```

#### 基于请求内容的哈希

```json
{
  "strategy": {
    "mode": "hash",
    "hashSource": "request"
  },
  "targets": [
    {
      "provider": "provider-a-id",
      "weight": 50
    },
    {
      "provider": "provider-b-id",
      "weight": 50
    }
  ]
}
```

### Hash Source 说明

| hashSource | 说明 | 使用场景 |
|------------|------|----------|
| `virtualKey` | 使用虚拟密钥ID作为哈希源 | 相同API Key的请求总是路由到同一provider |
| `request` | 使用请求体的哈希作为源 | 相同请求内容路由到同一provider（更细粒度） |

### 权重如何影响哈希

权重决定了哈希空间的分配：
- Provider A (weight: 60) → 占据60%的哈希空间
- Provider B (weight: 40) → 占据40%的哈希空间

这样既保证了一致性，又实现了按权重的流量分配。

---

## 4. Affinity（时间窗口亲和性）🆕

### 工作原理
- 选择一个provider后，在配置的TTL时间内持续使用它
- TTL过期后，重新选择provider（基于权重随机）
- 如果当前provider不可用，立即切换到其他可用provider
- 每个routing config独立维护亲和性状态

### 适用场景
- 希望在短时间内保持provider的连续性
- 最大化provider端的缓存命中率
- 减少provider切换带来的冷启动开销

### 配置示例

```json
{
  "strategy": {
    "mode": "affinity",
    "affinityTTL": 300000
  },
  "targets": [
    {
      "provider": "provider-a-id",
      "weight": 70,
      "override_params": {
        "model": "gpt-4"
      }
    },
    {
      "provider": "provider-b-id",
      "weight": 30,
      "override_params": {
        "model": "gpt-4"
      }
    }
  ]
}
```

### 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `affinityTTL` | number | 300000 (5分钟) | 亲和性持续时间（毫秒） |

### 行为说明

1. **初始选择**：第一次请求时，基于权重随机选择一个provider
2. **持续使用**：在TTL时间内，所有请求都使用同一个provider
3. **TTL过期**：重新进行加权随机选择
4. **Provider不可用**：立即切换到其他可用provider，重置TTL

### 示例时间线

```
时刻 0s:   选择 Provider A (weight: 70)，设置TTL=300s
时刻 10s:  继续使用 Provider A（剩余 290s）
时刻 100s: 继续使用 Provider A（剩余 200s）
时刻 150s: Provider A 熔断，切换到 Provider B，重置TTL=300s
时刻 200s: 继续使用 Provider B（剩余 250s）
时刻 450s: TTL过期，重新选择（可能选到 Provider A 或 B）
```

---

## 模式选择指南

### 选择流程图

```
需要故障转移/主备模式？
  ├─ 是 → fallback
  └─ 否 ↓

需要最大化缓存命中率？
  ├─ 是 ↓
  │   └─ 希望同一用户总是打到同一provider？
  │       ├─ 是 → hash (hashSource: virtualKey)
  │       └─ 否 → affinity
  └─ 否 → loadbalance
```

### 场景示例

| 场景 | 推荐模式 | 理由 |
|------|---------|------|
| 多个provider按比例分流 | `loadbalance` | 简单的加权随机分配 |
| 成本优化，优先用便宜的 | `fallback` | 主provider不可用时才切换 |
| 多租户SaaS，每个租户固定后端 | `hash` (virtualKey) | 相同租户总是路由到相同provider |
| Prompt Cache优化 | `affinity` | 短时间内使用同一provider，最大化缓存 |
| 有状态的provider | `hash` (virtualKey) | 保持会话一致性 |

---

## 熔断器保护

**所有模式**都集成了熔断器保护：

- 自动检测不可用的provider
- 失败达到阈值时触发熔断（默认2次）
- 熔断期间不会选择该provider
- 超时后自动尝试恢复
- 成功达到阈值后恢复正常（默认2次）

熔断器配置：
```typescript
{
  failureThreshold: 2,      // 2次失败触发熔断
  successThreshold: 2,      // 2次成功恢复
  timeout: 120000,          // 120秒后转为半开状态
  halfOpenMaxAttempts: 3    // 半开状态最多3次尝试
}
```

---

## API 使用示例

### 创建路由配置

```bash
POST /routing-configs
Content-Type: application/json

{
  "name": "Hash模式示例",
  "description": "基于虚拟密钥的一致性哈希",
  "type": "hash",
  "config": {
    "strategy": {
      "mode": "hash",
      "hashSource": "virtualKey"
    },
    "targets": [
      {
        "provider": "provider-a-id",
        "weight": 60
      },
      {
        "provider": "provider-b-id",
        "weight": 40
      }
    ]
  },
  "createVirtualModel": true,
  "virtualModelName": "claude-hash-balanced"
}
```

### 更新路由配置

```bash
PUT /routing-configs/:id
Content-Type: application/json

{
  "config": {
    "strategy": {
      "mode": "affinity",
      "affinityTTL": 600000
    },
    "targets": [
      {
        "provider": "provider-a-id",
        "weight": 70
      },
      {
        "provider": "provider-b-id",
        "weight": 30
      }
    ]
  }
}
```

---

## 日志监控

各模式都会输出详细的路由日志：

### Hash 模式日志
```
[Routing] Hash路由: hashKey=abc12345... -> provider=provider-a-id
```

### Affinity 模式日志
```
[Routing] Affinity路由: 选择新provider=provider-a-id (TTL=300秒)
[Routing] Affinity路由: 使用缓存的provider=provider-a-id (剩余245秒)
[Routing] Affinity路由: 缓存的provider=provider-a-id不可用，重新选择
```

---

## 注意事项

1. **Hash模式**
   - 如果provider数量变化，哈希分配会重新计算
   - 适合provider数量相对稳定的场景
   - hashSource为request时，请求体任何变化都会导致哈希值变化

2. **Affinity模式**
   - 状态存储在内存中，服务重启后会重置
   - TTL设置过长可能导致流量分配不均
   - TTL设置过短会降低缓存效益

3. **权重设置**
   - 权重为0或未设置时，该target可能不会被选中（loadbalance/hash模式）
   - Fallback模式忽略权重，按配置顺序选择

4. **熔断器**
   - 所有模式都受熔断器保护
   - 即使是hash/affinity模式，provider熔断后也会切换到其他可用provider
