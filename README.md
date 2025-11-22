# LLM Gateway

一个轻量级 LLM 网关管理系统，提供直观的 Web UI 界面，用于管理多个 LLM 提供商、虚拟密钥、路由配置和模型管理

<img width="2158" height="1577" alt="image" src="https://github.com/user-attachments/assets/7632e901-e572-4373-ac85-44c46ec86526" />
<img width="2682" height="1397" alt="image" src="https://github.com/user-attachments/assets/196adf78-2346-41f9-903b-a18920464486" />


更多截图请见 [服务截图](./docs/screenshot.md)

## 特性

- **提供商管理**: 支持 20+ 主流 LLM 提供商，包括 OpenAI、Anthropic、Google、DeepSeek 等
- **虚拟密钥**: 创建和管理虚拟 API 密钥，支持速率限制和访问控制
- **路由配置**: 支持负载均衡和故障转移策略，提高服务可用性
- **模型管理**: 统一管理所有提供商的模型，支持批量导入和自定义配置
- **多端点支持**: 提供 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 等多个兼容端点
- **Prompt 管理**: 为虚拟模型配置 prompt 处理规则，支持替换、前置添加、系统消息等操作
- **LiteLLM 预设集成**: 自动从 LiteLLM 官方库获取模型配置，支持搜索和一键应用
- **健康监控**: 公开免登录健康检查页面，实时展示模型可用率、延迟分位数（P50/P95）和错误分布
- **用户认证**: 基于 JWT 的安全认证机制
- **实时监控**: 仪表盘展示系统状态和配置信息

## 快速开始

### 前置要求

- Node.js v20 或更高版本
- npm / cnpm
- Docker (可选,用于容器化部署)

### 安装

```bash
# 克隆仓库
git clone https://github.com/sxueck/llm-gateway.git
cd llm-gateway

# 安装后端依赖
pnpm install

# 安装前端依赖
cd web
pnpm install
cd ..
```

### 配置

创建 `.env` 文件并配置环境变量:

```bash
cp .env.example .env
```

编辑 `.env` 文件:

```env
PORT=3000
NODE_ENV=development
DB_PATH=./data/gateway.db
LOG_LEVEL=info
JWT_SECRET=your-secret-key-change-this-in-production
```

**重要**: 生产环境请务必修改 `JWT_SECRET` 为一个强随机字符串(至少 32 字符)。

### 启动服务

```bash
npm run start:all
```

此命令将自动:
1. 分别启动前后端服务
2. 初始化数据库

### 使用 Docker Compose 方式启动

请参考 [Docker 部署指南](./docs/DOCKER_DEPLOYMENT.md)


### 快速使用

1. 添加供应商，这个供应商指的是类似 DeepSeek 这样的 AI 服务商，并填入供应商密钥
2. 添加模型，模型指的是供应商提供的 AI 模型，例如 DeepSeek 的 `deepseek-chat`
3. 创建虚拟密钥，虚拟密钥用于访问 LLM Gateway 的 API
4. (可选) 为虚拟模型配置 Prompt 管理规则，实现 prompt 的动态修改和增强
5. 在应用中使用虚拟密钥访问 LLM Gateway 的 API

## 健康监控

LLM Gateway 提供公开的健康监控页面，无需登录即可访问，实时展示各模型的可用性和性能指标。

### 启用持久监控

- 在“系统设置 -> 监控设置”中开启“启用持久监控”
- 首次开启时系统会自动创建一个“监控专用虚拟密钥”，具备访问全部模型的能力，仅用于健康检查，且默认禁用请求体/响应体日志
- 只有当“持久监控”为开启状态时，以下能力才会生效：
  - 后端健康检查调度器运行（周期性对目标执行健康检查）
  - 公开监控页面与相关免鉴权 API 可访问
- 可随时关闭“持久监控”，系统将停止调度器并关闭公开访问（公开端点返回 404）

### 访问健康监控页面

访问 `http://your-gateway-url/status` 即可查看健康监控页面。

### 功能特性

- **实时状态监控**: 显示所有配置的模型目标的当前状态（健康/降级/宕机）
- **可用率统计**: 展示 1小时 和 24小时 的可用率
- **延迟指标**: P50 和 P95 延迟统计
- **错误追踪**: 记录并展示错误类型和错误信息
- **自动刷新**: 默认每 60 秒自动刷新数据
- **详细历史**: 点击目标可查看详细的检查历史记录

### API 端点

健康监控提供以下公开 API 端点（免鉴权）：

- `GET /public/health/summary` - 获取所有目标的汇总信息
- `GET /public/health/targets` - 获取目标清单
- `GET /public/health/detail?target_id=xxx` - 获取单个目标的详细信息
- `GET /public/health/runs?target_id=xxx&window=24h&page=1&page_size=50` - 获取检查历史记录

### 配置健康检查目标

健康检查目标通过数据库配置，可以为任何模型或虚拟模型设置健康检查：

```sql
-- 示例：为模型添加健康检查
INSERT INTO health_targets (id, name, type, target_id, enabled, check_interval_seconds, check_prompt)
VALUES ('target-1', 'DeepSeek Chat', 'model', 'model-id-here', 1, 300, 'Say "OK"');
```

主要配置参数：
- `check_interval_seconds`: 检查频率（秒），默认 300 秒（5分钟）
- `check_prompt`: 健康检查使用的提示词，默认为 "Say 'OK'"
- `check_config`: JSON 配置，可设置超时、重试等参数

### 限流保护

健康监控 API 默认启用限流保护，每个 IP 每分钟最多 60 个请求，超过限制将返回 429 错误。

## 开发指南

### 开发环境设置

```bash
# 安装后端依赖
pnpm install

# 安装前端依赖
cd web && pnpm install && cd ..

# 直接启动前后端
npm run start:all
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License - 详见 [LICENSE](./LICENSE) 文件

## 致谢

- [Naive UI](https://www.naiveui.com/) - UI 组件库
- [Fastify](https://www.fastify.io/) - 高性能 Web 框架
