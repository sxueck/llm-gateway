# Docker 部署指南

本文档介绍如何使用 Docker 和 Docker Compose 部署 LLM Gateway。

## 前置要求

- Docker 20.10 或更高版本
- Docker Compose 2.0 或更高版本
- 至少 2GB 可用内存
- 至少 5GB 可用磁盘空间

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/sxueck/llm-gateway.git
cd llm-gateway
```

### 2. 配置环境变量

创建 `.env` 文件:

```bash
cp .env.example .env
```

编辑 `.env` 文件,至少需要设置以下变量:

```env
JWT_SECRET=your-strong-random-secret-key-at-least-32-characters
PUBLIC_URL=http://your-domain.com
```

**重要**: 生产环境必须修改 `JWT_SECRET` 为一个强随机字符串。

### 3. 创建必要的目录

```bash
mkdir -p data portkey-config
touch portkey-config/conf.json # 注意这里如果没有执行会无法保存模型
```

### 4. 启动服务

```bash
docker-compose up -d
```

### 5. 查看日志

```bash
docker-compose logs -f
```

### 6. 访问应用

- Web UI: http://localhost:3000
- API: http://localhost:3000/api
- 健康检查: http://localhost:3000/health

## 服务说明

### Portkey Gateway

- **镜像**: `portkeyai/gateway:latest`
- **容器名**: `portkey-gateway`
- **端口**: 8787 (仅本地访问)
- **功能**: 核心 LLM 网关服务,处理实际的 API 请求转发

### LLM Gateway

- **镜像**: 本地构建
- **容器名**: `llm-gateway`
- **端口**: 3000
- **功能**: 管理界面和 API,提供提供商管理、虚拟密钥、路由配置等功能

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `JWT_SECRET` | JWT 密钥,生产环境必须修改 | 默认值(不安全) |
| `NODE_ENV` | 运行环境 | production |
| `PORT` | 服务端口 | 3000 |
| `DB_PATH` | 数据库文件路径 | /app/data/gateway.db |
| `PORTKEY_CONFIG_PATH` | Portkey 配置文件路径 | /app/portkey-config/conf.json |
| `LOG_LEVEL` | 日志级别 | info |
| `PORTKEY_GATEWAY_URL` | Portkey Gateway 地址 | http://portkey-gateway:8787 |
| `PUBLIC_URL` | 公网访问地址 | http://localhost:3000 |
| `API_REQUEST_LOG_RETENTION_DAYS` | API 请求日志保留天数 | 3 |

## 数据持久化

以下目录会被挂载到宿主机,确保数据持久化:

- `./data` - 数据库文件
- `./portkey-config` - Portkey Gateway 配置文件

## 生产环境部署建议

### 使用反向代理

建议使用 Nginx 或 Traefik 作为反向代理,配置 HTTPS:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
