# LLM Gateway

基于 Portkey Gateway 的轻量级 LLM 网关管理系统，提供直观的 Web UI 界面，用于管理多个 LLM 提供商、虚拟密钥、路由配置和模型管理。

<img width="3798" height="1967" alt="image" src="https://github.com/user-attachments/assets/1e1d9c6c-7a6b-4cef-9f1d-b188cd38dfbe" />
<img width="1778" height="977" alt="image" src="https://github.com/user-attachments/assets/fe65a33e-73f3-481e-90b1-cb4a732122fa" />


更多截图请见 [服务截图](./docs/screenshot.md)

## 特性

- **提供商管理**: 支持 20+ 主流 LLM 提供商，包括 OpenAI、Anthropic、Google、DeepSeek 等
- **虚拟密钥**: 创建和管理虚拟 API 密钥，支持速率限制和访问控制
- **路由配置**: 支持负载均衡和故障转移策略，提高服务可用性
- **模型管理**: 统一管理所有提供商的模型，支持批量导入和自定义配置
- **Prompt 管理**: 为虚拟模型配置 prompt 处理规则，支持替换、前置添加、系统消息等操作
- **LiteLLM 预设集成**: 自动从 LiteLLM 官方库获取模型配置，支持搜索和一键应用
- **智能路由**: 基于模型、提供商、地区等规则实现智能请求分发
- **用户认证**: 基于 JWT 的安全认证机制
- **实时监控**: 仪表盘展示系统状态和配置信息

## 快速开始

### 前置要求

- Node.js v20 或更高版本
- npm / cnpm
- Docker (可选,用于运行 Portkey Gateway)

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

### 使用 Docker Compose 方式启动

请参考 [Docker 部署指南](./docs/DOCKER_DEPLOYMENT.md)

### 访问应用

- **Web UI**: http://localhost:5173
- **后端 API**: http://localhost:3000
- **Portkey Gateway**: http://localhost:8787 (仅本地访问，不对外开放)

**安全说明**: Portkey Gateway 已配置为仅监听本地回环地址 (127.0.0.1)，外部网络无法直接访问。所有 API 请求必须通过 LLM Gateway 进行转发，确保统一的认证和访问控制。

### 快速使用

1. 添加供应商，这个供应商指的是类似 DeepSeek 这样的 AI 服务商，并填入供应商密钥
2. 添加模型，模型指的是供应商提供的 AI 模型，例如 DeepSeek 的 `deepseek-chat`
3. 创建虚拟密钥，虚拟密钥用于访问 LLM Gateway 的 API
4. (可选) 为虚拟模型配置 Prompt 管理规则，实现 prompt 的动态修改和增强
5. 在应用中使用虚拟密钥访问 LLM Gateway 的 API

## 技术栈

### 后端
- **运行时**: Node.js v20+
- **框架**: Fastify 5.x - 高性能 Web 框架
- **语言**: TypeScript 5.x
- **数据库**: SQL.js - 轻量级 SQLite 数据库
- **认证**: JWT (@fastify/jwt)
- **日志**: Pino - 高性能日志库
- **验证**: Zod - TypeScript 优先的模式验证
- **其他**: Tiktoken (Token 计数)、nanoid (ID 生成)

### 前端
- **框架**: Vue 3.5+
- **构建工具**: Vite 6.x
- **UI 组件库**: Naive UI 2.4+
- **状态管理**: Pinia 2.3+
- **路由**: Vue Router 4.5+
- **HTTP 客户端**: Axios 1.7+
- **国际化**: Vue i18n 9.14+
- **图标**: Ionicons 5 & Material Icons

## 项目结构

```
llm-gateway/
├── src/                          # 后端源代码
│   ├── config/                   # 配置管理
│   ├── db/                       # 数据库操作
│   ├── routes/                   # API 路由
│   ├── services/                 # 业务逻辑服务
│   ├── types/                    # TypeScript 类型定义
│   ├── utils/                    # 工具函数
│   └── index.ts                  # 应用入口
├── web/                          # 前端源代码
│   ├── src/
│   │   ├── components/           # Vue 组件
│   │   ├── views/                # 页面视图
│   │   ├── stores/               # Pinia 状态管理
│   │   ├── router/               # 路由配置
│   │   ├── i18n/                 # 国际化配置
│   │   ├── utils/                # 工具函数
│   │   └── main.ts               # 应用入口
│   └── vite.config.ts            # Vite 配置
├── docs/                         # 文档
│   ├── DOCKER_DEPLOYMENT.md      # Docker 部署指南
│   └── screenshot.md             # 服务截图
├── scripts/                      # 构建和工具脚本
├── data/                         # 数据存储目录
├── portkey-config/               # Portkey 配置文件
├── docker-compose.yml            # Docker Compose 配置
├── Dockerfile                    # Docker 镜像配置
├── package.json                  # 后端依赖配置
├── tsconfig.json                 # TypeScript 配置
└── README.md                     # 本文件
```

## 开发指南

### 开发环境设置

```bash
# 安装后端依赖
pnpm install

# 安装前端依赖
cd web && pnpm install && cd ..

# 启动开发服务器
npm run dev
```

### 构建

```bash
# 构建后端
npm run build

# 构建前端
cd web && npm run build && cd ..
```

### 环境变量

详见 `.env.example` 文件，主要配置项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| PORT | 后端服务端口 | 3000 |
| NODE_ENV | 运行环境 | development |
| DB_PATH | 数据库文件路径 | ./data/gateway.db |
| PORTKEY_CONFIG_PATH | Portkey 配置文件路径 | ./portkey-config/conf.json |
| LOG_LEVEL | 日志级别 | info |
| JWT_SECRET | JWT 密钥 (至少 32 字符) | 必填 |
| PUBLIC_URL | 公开访问 URL | http://localhost:3000 |
| DEMO_MODE | 演示模式 | false |

## Demo

[Demo](http://demo-api.sxueck.com:3000/)

账户: demo / demo1234

注意：Demo 站会每 3 天自动清空数据，同时请不要填写真实的 API 密钥

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License - 详见 [LICENSE](./LICENSE) 文件

## 致谢

- [Portkey Gateway](https://github.com/Portkey-AI/gateway) - 核心网关服务
- [Naive UI](https://www.naiveui.com/) - UI 组件库
- [Fastify](https://www.fastify.io/) - 高性能 Web 框架
