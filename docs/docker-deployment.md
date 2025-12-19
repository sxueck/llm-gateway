# Docker 部署指南

本文档介绍如何使用 Docker 和 Docker Compose 部署 LLM Gateway, 具体可以下载 Compose 目录以一键启动

## 前置要求

- Docker 20.10 或更高版本
- Docker Compose 2.0 或更高版本
- 至少 2GB 可用内存
- 至少 5GB 可用磁盘空间

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/sxueck/llm-gateway.git
cd llm-gateway/compose
```

### 2. 配置环境变量

创建 `.env` 文件:

```bash
cp .env.example .env
```

编辑 `.env` 文件,至少需要设置以下变量:

```env
JWT_SECRET=your-strong-random-secret-key-at-least-32-characters # 注意修改这个值！！！
```

**重要**: 生产环境必须修改 `JWT_SECRET` 为一个强随机字符串。

### 3. 启动服务

```bash
docker-compose up -d
```

### 4. 查看日志

```bash
docker-compose logs -f
```

### 5. 访问应用

- Web UI: http://localhost:3000
- API: http://localhost:3000/api

## 服务说明

### MySQL

- **镜像**: `mysql:8.0`
- **端口**: 3306
- **功能**: 核心 LLM 存储服务

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
| `LOG_LEVEL` | 日志级别 | info |
| `API_REQUEST_LOG_RETENTION_DAYS` | API 请求日志保留天数 | 3 |


## 生产环境部署建议

### 使用反向代理

建议使用 Nginx 作为反向代理,配置 HTTPS:

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
