# LLM Gateway

基于 Portkey Gateway 的轻量级 LLM 网关管理系统, 提供直观的 Web UI 界面,用于管理多个 LLM 提供商、虚拟密钥、路由配置和模型管理。

<img width="2290" height="1363" alt="图片" src="https://github.com/user-attachments/assets/662d8585-b523-40a5-bb2a-33ad570f0d30" />

更多截图请见 [服务截图](./docs/screenshot.md)

## 特性

- **提供商管理**: 支持 20+ 主流 LLM 提供商,包括 OpenAI、Anthropic、Google、DeepSeek 等
- **虚拟密钥**: 创建和管理虚拟 API 密钥,支持速率限制和访问控制
- **路由配置**: 支持负载均衡和故障转移策略,提高服务可用性
- **模型管理**: 统一管理所有提供商的模型,支持批量导入和自定义配置
- **LiteLLM 预设集成**: 自动从 LiteLLM 官方库获取模型配置,支持搜索和一键应用
- **分布式 Agent 部署**: 支持在远程服务器上部署 Portkey Gateway Agent,实现分布式架构
- **智能路由**: 基于模型、提供商、地区等规则实现智能请求分发
- **用户认证**: 基于 JWT 的安全认证机制
- **实时监控**: 仪表盘展示系统状态和配置信息

## 快速开始

### 前置要求

- Node.js v20 或更高版本
- npm / cnpm
- Docker (可选,用于运行 Portkey Gateway)
- Golang 1.18+ (可选,用于构建 Portkey Gateway Agent)

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
PORTKEY_CONFIG_PATH=./portkey-config/conf.json
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
3. 构建 Portkey Gateway Agent

### 访问应用

- **Web UI**: http://localhost:5173
- **后端 API**: http://localhost:3000
- **Portkey Gateway**: http://localhost:8787 (仅本地访问，不对外开放)

**安全说明**: Portkey Gateway 已配置为仅监听本地回环地址 (127.0.0.1)，外部网络无法直接访问。所有 API 请求必须通过 LLM Gateway 进行转发，确保统一的认证和访问控制。

### 快速使用

1. 添加供应商，这个供应商指的是类似 DeepSeek 这样的 AI 服务商，并填入供应商密钥
2. 添加模型，模型指的是供应商提供的 AI 模型，例如 DeepSeek 的 `deepseek-chat`
3. 创建虚拟密钥，虚拟密钥用于访问 LLM Gateway 的 API
4. 在应用中使用虚拟密钥访问 LLM Gateway 的 API

## Demo

[Demo](http://demo-api.sxueck.com:3000/)

账户: demo / demo1234

注意：Demo 站会每 3 天自动清空数据，同时请不要填写真实的 API 密钥

## 贡献

欢迎提交 Issue 和 Pull Request!

## 许可证

MIT License

## 致谢

- [Portkey Gateway](https://github.com/Portkey-AI/gateway) - 核心网关服务
- [Naive UI](https://www.naiveui.com/) - UI 组件库
- [Fastify](https://www.fastify.io/) - 高性能 Web 框架

