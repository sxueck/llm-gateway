# Docker 部署指南

本文档介绍如何使用 Docker 和 Docker Compose 部署 LLM Gateway, 可以通过下载 Compose 目录以一键启动，目录内已经配置完成了 MySQL 的相关参数

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

**重要**: 生产环境必须修改 `JWT_SECRET` 为一个强随机字符串，该值也会用于加密数据，如果需要迁移环境请保持该值不变（例如备份等情况）

### 3. 启动服务

```bash
docker-compose up -d
```

### 4. 查看日志

```bash
docker-compose logs -f
```

### 5. 访问应用

- Web UI: http://localhost:13030
- API: http://localhost:13030/api

## 服务说明

### MySQL

- **镜像**: `mysql:8.0`
- **端口**: 3306
- **功能**: 核心 LLM 存储服务

### LLM Gateway

- **镜像**: 本地构建
- **容器名**: `llm-gateway`
- **端口**: 13030 (映射到容器内 3000)
- **功能**: 管理界面和 API,提供提供商管理、虚拟密钥、路由配置等功能

## 环境变量说明

| 变量名                           | 说明                                           | 默认值                                         |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `JWT_SECRET`                     | JWT 密钥,生产环境必须修改                      | 默认值(不安全)                                 |
| `NODE_ENV`                       | 运行环境                                       | production                                     |
| `PORT`                           | 服务端口                                       | 3000                                           |
| `LOG_LEVEL`                      | 日志级别                                       | info                                           |
| `API_REQUEST_LOG_RETENTION_DAYS` | API 请求日志保留天数                           | 14                                             |
| `MYSQL_PASSWORD`                 | MySQL root 密码                                | your-mysql-password                            |
| `DOCKER_GID`                     | 宿主机 docker 组 gid,用于读写 docker.sock      | 999                                            |
| `AGENT_WORKSPACE_DIR`            | Agent Search worker workspace 目录(两侧同路径) | /opt/llm-gateway/agent-workspaces              |
| `AGENT_WORKER_IMAGE`             | craft-worker 镜像                              | ghcr.io/sxueck/llm-gateway/craft-worker:latest |
| `AGENT_WORKER_GATEWAY_URL`       | worker 回连网关的地址                          | http://host.docker.internal:13030              |

## 启用 Agent Search (craft-worker)

Compose 默认启用 Agent Search:网关通过挂载的 `/var/run/docker.sock` 以 Docker SDK 拉起隔离的 `craft-worker` 容器。首次部署前需完成以下准备:

### 1. 准备 workspace 目录

worker 的 workspace 会被 Docker daemon 按**宿主机路径**挂载进 worker 容器,因此网关容器内必须与宿主机使用完全一致的绝对路径:

```bash
mkdir -p /opt/llm-gateway/agent-workspaces
# 网关容器内以 uid 1001 (nodejs) 运行
sudo chown -R 1001:1001 /opt/llm-gateway/agent-workspaces
```

如需换目录,同步修改 `.env` 中的 `AGENT_WORKSPACE_DIR` 即可(compose 会自动两侧同路径挂载)。

### 2. 配置 docker.sock 权限

查宿主机 docker 组 gid 并写入 `.env` 的 `DOCKER_GID`:

```bash
getent group docker | cut -d: -f3
```

> 安全提示:挂载 docker.sock 等同于赋予网关容器宿主机 root 级能力,请仅在自己可信的主机上启用。

### 3. 模型调用计费

无需预置内部密钥:worker 的模型调用由网关 internal 通道自动放行到**创建 run 的虚拟密钥**,用量与费用记账到该密钥。只需确保发起 Agent Search 的 virtual key 已绑定插件所需的模型(如 `search-fast`)。

### 4. 启动并验证

```bash
docker-compose up -d
docker-compose logs llm-gateway | grep "Agent search executor"
# 预期输出: Agent search executor: docker (ghcr.io/sxueck/llm-gateway/craft-worker:latest)
```

之后在 Web UI 的 Agent Search 页面发起一次搜索,`docker ps` 中应出现短暂的 `craft-worker-<runId>` 容器。

## 生产环境部署建议

### 使用反向代理

关于反代配置的疑点，可以参考 [Issue #23](https://github.com/sxueck/llm-gateway/issues/23)

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
        proxy_pass http://localhost:13030;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
