# LLM Gateway Agent

远程 Portkey Gateway 管理 Agent，用于自动管理和同步 Portkey Gateway 容器配置。

## 功能特性

- 自动注册到 LLM Gateway
- 定期心跳保持连接
- 自动同步 Portkey 配置
- 配置变更时自动重启容器
- Docker 容器生命周期管理
- 跨平台支持 (Linux/macOS/Windows)

## 快速开始

### 前置要求

- Docker 已安装并运行
- Go 1.21+ (仅开发时需要)

### 安装

1. 下载对应平台的二进制文件
2. 创建配置文件 `.env`
3. 运行 Agent

### 配置

创建 `.env` 文件:

```bash
GATEWAY_ID=your-gateway-id
API_KEY=your-api-key
LLM_GATEWAY_URL=http://localhost:3000
PORTKEY_CONTAINER_NAME=portkey-gateway
PORTKEY_PORT=8787
AGENT_PORT=8788
LOG_LEVEL=info
CONFIG_SYNC_INTERVAL=300
HEARTBEAT_INTERVAL=30
```

### 运行

```bash
./llm-gateway-agent
```

### 开发

```bash
# 安装依赖
make install

# 本地运行
make run

# 构建
make build

# 构建所有平台
make build-all
```

## 配置说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| GATEWAY_ID | 网关 ID | 必填 |
| API_KEY | API 密钥 | 必填 |
| LLM_GATEWAY_URL | LLM Gateway 地址 | http://localhost:3000 |
| PORTKEY_CONTAINER_NAME | Portkey 容器名称 | portkey-gateway |
| PORTKEY_PORT | Portkey 端口 | 8787 |
| AGENT_PORT | Agent 端口 | 8788 |
| LOG_LEVEL | 日志级别 (debug/info/warn/error) | info |
| CONFIG_SYNC_INTERVAL | 配置同步间隔 (秒) | 300 |
| HEARTBEAT_INTERVAL | 心跳间隔 (秒) | 30 |

## 架构

```
LLM Gateway (中心节点)
    ↕ (HTTPS)
Remote Agent
    ↓ (HTTP)
Portkey Gateway Container (本地)
```

## API 端点

Agent 与 LLM Gateway 通信的端点:

- `POST /api/agent/register` - 注册节点
- `POST /api/agent/heartbeat` - 发送心跳
- `GET /api/agent/portkey-config` - 获取配置
- `POST /api/agent/report-status` - 报告状态

## 日志

Agent 会输出详细的运行日志，包括:

- 注册状态
- 心跳状态
- 配置同步状态
- 容器管理操作
- 错误信息

## 故障排查

### Agent 无法启动

1. 检查 Docker 是否运行
2. 检查配置文件是否正确
3. 检查网络连接

### 配置同步失败

1. 检查 LLM Gateway URL 是否正确
2. 检查 API Key 是否有效
3. 检查网络连接

### 容器启动失败

1. 检查 Docker 权限
2. 检查端口是否被占用
3. 查看容器日志: `docker logs portkey-gateway`

## License

MIT

