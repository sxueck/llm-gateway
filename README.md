# LLM Gateway

基于 Portkey Gateway 的轻量级 LLM 网关管理系统,提供直观的 Web UI 界面,用于管理多个 LLM 提供商、虚拟密钥、路由配置和模型管理。

## 特性

- **提供商管理**: 支持 20+ 主流 LLM 提供商,包括 OpenAI、Anthropic、Google、DeepSeek 等
- **虚拟密钥**: 创建和管理虚拟 API 密钥,支持速率限制和访问控制
- **路由配置**: 支持负载均衡和故障转移策略,提高服务可用性
- **模型管理**: 统一管理所有提供商的模型,支持批量导入和自定义配置
- **LiteLLM 预设集成**: 自动从 LiteLLM 官方库获取模型配置,支持搜索和一键应用
- **Docker 集成**: 一键启动 Portkey Gateway 容器,无需手动配置
- **用户认证**: 基于 JWT 的安全认证机制
- **实时监控**: 仪表盘展示系统状态和配置信息

## 快速开始

### 前置要求

- Node.js v18 或更高版本
- pnpm / npm / yarn
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

#### 方式一: 一键启动(推荐)

```bash
pnpm run start:all
```

此命令将自动:
1. 检查并启动 Docker
2. 启动 Portkey Gateway 容器
3. 启动后端服务(端口 3000)
4. 启动前端开发服务器(端口 5173)

#### 方式二: 分别启动

```bash
# 启动后端
pnpm run dev

# 在另一个终端启动前端
cd web
pnpm run dev
```

Portkey Gateway 可以在 Web UI 的"系统设置"页面一键启动。

### 访问应用

- **Web UI**: http://localhost:5173
- **后端 API**: http://localhost:3000
- **Portkey Gateway**: http://localhost:8787 (仅本地访问，不对外开放)

**安全说明**: Portkey Gateway 已配置为仅监听本地回环地址 (127.0.0.1)，外部网络无法直接访问。所有 API 请求必须通过 LLM Gateway 进行转发，确保统一的认证和访问控制。

### 首次使用

1. 访问 http://localhost:5173/register 注册管理员账号
2. 登录系统
3. 在"提供商管理"页面添加 LLM 提供商
4. 在"虚拟密钥管理"页面创建虚拟密钥
5. 使用虚拟密钥调用 LLM API

## 核心功能

### 提供商管理

- 支持 20+ 主流 LLM 提供商
- 预设配置模板,快速添加提供商
- 自定义 API Base URL 和认证信息
- 提供商连接测试
- 批量导入模型列表

### 虚拟密钥管理

- 自动生成或自定义虚拟密钥
- 密钥与提供商/模型映射
- 速率限制配置
- 密钥启用/禁用控制
- 一键复制密钥

### 路由配置

- **负载均衡**: 按权重分配请求到多个提供商
- **故障转移**: 主提供商失败时自动切换到备用提供商
- 虚拟模型创建,统一多个提供商的模型
- 可视化配置界面

### 模型管理

- 统一管理所有提供商的模型
- 支持批量导入和手动添加
- 模型启用/禁用控制
- 模型搜索和过滤
- **LiteLLM 预设集成**:
  - 自动从 LiteLLM 官方库同步模型配置
  - 智能搜索匹配模型
  - 一键应用模型属性（令牌限制、成本、功能支持等）
  - 每 24 小时自动更新预设库
  - 详见 [LiteLLM 预设功能文档](docs/LITELLM_PRESETS.md)

### 系统管理

- Docker 容器一键启动/停止
- Portkey Gateway 配置自动生成
- 配置文件实时同步
- 系统状态监控

## 使用示例

### 调用 LLM API

使用虚拟密钥调用 LLM API:

```bash
curl -X POST http://localhost:3000/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_VIRTUAL_KEY" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

### 查询可用模型

```bash
curl http://localhost:3000/models \
  -H "Authorization: Bearer YOUR_VIRTUAL_KEY"
```

## 生产部署

### 使用 Docker Compose

项目包含 `docker-compose.yml` 文件,可以快速部署:

```bash
# 设置 JWT 密钥
export JWT_SECRET=your-production-secret-key

# 启动服务
docker-compose up -d
```

### 手动构建部署

```bash
# 1. 构建后端
pnpm run build

# 2. 构建前端
cd web
pnpm run build
cd ..

# 3. 设置环境变量
export NODE_ENV=production
export JWT_SECRET=your-production-secret-key

# 4. 启动后端
pnpm start
```

前端构建产物在 `web/dist` 目录,可以使用 Nginx 等 Web 服务器托管。

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        root /path/to/llm-gateway/web/dist;
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## API 文档

### 认证接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 用户注册 |
| POST | `/api/auth/login` | 用户登录 |
| GET | `/api/auth/profile` | 获取用户信息 |

### 提供商管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/providers` | 获取提供商列表 |
| POST | `/api/admin/providers` | 创建提供商 |
| PUT | `/api/admin/providers/:id` | 更新提供商 |
| DELETE | `/api/admin/providers/:id` | 删除提供商 |
| POST | `/api/admin/providers/:id/test` | 测试提供商连接 |
| POST | `/api/admin/providers/fetch-models` | 获取提供商模型列表 |
| POST | `/api/admin/providers/batch-import` | 批量导入提供商 |

#### 提供商导入/导出功能

系统支持提供商配置的导入和导出功能，方便批量管理和迁移配置。

**导出功能**：
- 在提供商管理页面点击"导出"按钮
- 可选择导出所有提供商或仅导出已启用的提供商
- 导出的 JSON 文件不包含 API Key（安全考虑）

**导入功能**：
1. 在提供商管理页面点击"导入"按钮
2. 选择之前导出的 JSON 配置文件
3. 系统会验证文件格式并显示确认对话框
4. 确认后执行导入，已存在的提供商会被自动跳过
5. 导入的提供商默认处于禁用状态，需要手动设置 API Key 后启用

**导入文件格式示例**：参见 `docs/provider-import-example.json`

### 虚拟密钥管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/virtual-keys` | 获取虚拟密钥列表 |
| POST | `/api/admin/virtual-keys` | 创建虚拟密钥 |
| PUT | `/api/admin/virtual-keys/:id` | 更新虚拟密钥 |
| DELETE | `/api/admin/virtual-keys/:id` | 删除虚拟密钥 |
| POST | `/api/admin/virtual-keys/validate` | 验证自定义密钥 |

### 模型管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/models` | 获取模型列表 |
| POST | `/api/admin/models` | 创建模型 |
| PUT | `/api/admin/models/:id` | 更新模型 |
| DELETE | `/api/admin/models/:id` | 删除模型 |

### 路由配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/routing-configs` | 获取路由配置列表 |
| POST | `/api/admin/routing-configs` | 创建路由配置 |
| PUT | `/api/admin/routing-configs/:id` | 更新路由配置 |
| DELETE | `/api/admin/routing-configs/:id` | 删除路由配置 |

### 系统管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/config/regenerate` | 重新生成配置文件 |
| GET | `/api/admin/config/status` | 获取配置文件状态 |
| POST | `/api/admin/docker/start` | 启动 Portkey Gateway |
| POST | `/api/admin/docker/stop` | 停止 Portkey Gateway |
| GET | `/api/admin/docker/status` | 获取容器状态 |

### OpenAI 兼容接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 获取可用模型列表 |
| POST | `/v1/chat/completions` | 聊天补全 |

## 技术栈

### 后端

- **运行时**: Node.js 18+
- **语言**: TypeScript
- **Web 框架**: Fastify
- **数据库**: SQLite (sql.js)
- **认证**: JWT (@fastify/jwt)
- **数据验证**: Zod
- **日志**: Pino

### 前端

- **框架**: Vue 3
- **语言**: TypeScript
- **构建工具**: Vite
- **UI 组件库**: Naive UI
- **状态管理**: Pinia
- **路由**: Vue Router
- **HTTP 客户端**: Axios
- **图标**: Ionicons

### 基础设施

- **容器化**: Docker
- **网关**: Portkey Gateway
- **包管理**: pnpm

## 项目结构

```
llm-gateway/
├── src/                    # 后端源代码
│   ├── config/            # 配置管理
│   ├── db/                # 数据库操作
│   ├── routes/            # API 路由
│   ├── services/          # 业务服务
│   ├── types/             # TypeScript 类型
│   ├── utils/             # 工具函数
│   └── index.ts           # 应用入口
├── web/                   # 前端源代码
│   ├── src/
│   │   ├── api/          # API 服务
│   │   ├── components/   # 公共组件
│   │   ├── layouts/      # 布局组件
│   │   ├── router/       # 路由配置
│   │   ├── stores/       # Pinia 状态管理
│   │   ├── types/        # TypeScript 类型
│   │   ├── utils/        # 工具函数
│   │   ├── views/        # 页面组件
│   │   ├── App.vue       # 根组件
│   │   └── main.ts       # 应用入口
│   └── package.json
├── data/                  # SQLite 数据库文件
├── portkey-config/        # Portkey Gateway 配置
├── Dockerfile             # Docker 镜像构建文件
├── docker-compose.yml     # Docker Compose 配置
└── package.json           # 后端依赖配置
```

## 常见问题

### 如何重置管理员密码?

删除 `data/gateway.db` 文件,重启服务后重新注册。

### Portkey Gateway 启动失败?

1. 检查 Docker 是否正在运行
2. 检查端口 8787 是否被占用
3. 查看容器日志: `docker logs portkey-gateway`

### 虚拟密钥无法使用?

1. 确保虚拟密钥已启用
2. 检查提供商配置是否正确
3. 验证提供商的 API Key 是否有效

### 如何添加自定义提供商?

在"提供商管理"页面选择"自定义"类型,填写提供商信息和 API 配置。

## 贡献

欢迎提交 Issue 和 Pull Request!

## 许可证

MIT License

## 致谢

- [Portkey Gateway](https://github.com/Portkey-AI/gateway) - 核心网关服务
- [Naive UI](https://www.naiveui.com/) - UI 组件库
- [Fastify](https://www.fastify.io/) - 高性能 Web 框架

