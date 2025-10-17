# LLM Gateway Agent

远程 Portkey Gateway 管理 Agent，用于自动管理和同步 Portkey Gateway 容器配置。

## 功能特性

- 自动注册到 LLM Gateway
- 定期心跳保持连接
- 自动同步 Portkey 配置
- 配置变更时自动重启容器
- Docker 容器生命周期管理

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
PORTKEY_PORT=8787  # Portkey Gateway 容器监听端口
AGENT_PORT=8788    # Agent HTTPS 服务监听端口
LOG_LEVEL=info
CONFIG_SYNC_INTERVAL=300
HEARTBEAT_INTERVAL=30
```

配置说明：
- `AGENT_PORT`：Agent 的 HTTPS 监听端口，用于接收来自 LLM Gateway 的请求（默认：8788）
- `PORTKEY_PORT`：Portkey Gateway 容器的 HTTP 监听端口，Agent 会将请求转发到此端口（默认：8787）

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
| PORTKEY_PORT | Portkey Gateway 容器监听端口 (本地) | 8787 |
| AGENT_PORT | Agent HTTPS 服务监听端口 (对外) | 8788 |
| LOG_LEVEL | 日志级别 (debug/info/warn/error) | info |
| CONFIG_SYNC_INTERVAL | 配置同步间隔 (秒) | 300 |
| HEARTBEAT_INTERVAL | 心跳间隔 (秒) | 30 |

## 架构

```
用户请求
    ↓
LLM Gateway (中心节点)
    ↓ (HTTPS, 带认证)
Remote Agent (监听 AGENT_PORT)
    ↓ (HTTP, 本地转发)
Portkey Gateway Container (监听 PORTKEY_PORT)
```

请求流程说明：
1. 用户请求发送到 LLM Gateway
2. LLM Gateway 根据路由规则选择目标 Agent
3. LLM Gateway 通过 HTTPS 将请求转发到 Agent (使用 X-Gateway-ID 和 X-API-Key 认证)
4. Agent 验证认证信息后，将请求转发到本地的 Portkey Gateway 容器
5. Portkey Gateway 处理请求并返回响应
6. 响应原路返回给用户

## TLS 证书

Agent 首次启动时会自动生成自签名 TLS 证书，证书包含：
- 服务器主机名
- 所有网络接口的 IP 地址
- localhost 和 127.0.0.1

证书文件位置：
- 证书：`cert.pem`
- 私钥：`key.pem`

证书有效期为 1 年。如需更新证书，删除现有证书文件后重启 Agent 即可自动重新生成。

LLM Gateway 会自动信任 Agent 的自签名证书，无需额外配置。

## License

MIT

