import { AGENT_DEFAULTS } from '../constants/agent.js';

export interface AgentInstallConfig {
  gatewayId: string;
  gatewayName: string;
  apiKey: string;
  agentPort: number;
  portkeyPort: number;
  llmGatewayUrl: string;
}

export function generateInstallScript(config: AgentInstallConfig): string {
  const { gatewayId, gatewayName, apiKey, agentPort, portkeyPort, llmGatewayUrl } = config;

  const script = `#!/bin/bash
set -e

echo "=========================================="
echo "LLM Gateway Agent 安装脚本"
echo "=========================================="
echo ""
echo "网关名称: ${gatewayName}"
echo "网关 ID: ${gatewayId}"
echo "Agent 端口: ${agentPort}"
echo "Portkey Gateway 端口: ${portkeyPort}"
echo "LLM Gateway URL: ${llmGatewayUrl}"
echo ""

if ! command -v docker &> /dev/null; then
    echo "错误: Docker 未安装"
    echo "请先安装 Docker: https://docs.docker.com/engine/install/"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo "错误: Docker 服务未运行或当前用户无权限访问 Docker"
    echo "请确保 Docker 服务已启动，或将当前用户添加到 docker 组"
    exit 1
fi

AGENT_DIR="/opt/llm-gateway-agent"
AGENT_BINARY="llm-gateway-agent"
AGENT_VERSION="1.0.0"

echo "正在检测系统架构..."
ARCH=\$(uname -m)
OS=\$(uname -s | tr '[:upper:]' '[:lower:]')

case "\${OS}" in
    linux)
        PLATFORM="linux"
        ;;
    darwin)
        PLATFORM="darwin"
        ;;
    *)
        echo "错误: 不支持的操作系统: \${OS}"
        exit 1
        ;;
esac

case "\${ARCH}" in
    x86_64|amd64)
        ARCH_SUFFIX="amd64"
        ;;
    aarch64|arm64)
        ARCH_SUFFIX="arm64"
        ;;
    *)
        echo "错误: 不支持的架构: \${ARCH}"
        exit 1
        ;;
esac

DOWNLOAD_URL="${llmGatewayUrl}/downloads/\${AGENT_BINARY}-\${PLATFORM}-\${ARCH_SUFFIX}"

echo "正在创建 Agent 目录..."
sudo mkdir -p "\${AGENT_DIR}"

echo "正在下载 Agent 二进制文件..."
if ! sudo curl -fL -o "\${AGENT_DIR}/\${AGENT_BINARY}" "\${DOWNLOAD_URL}"; then
    echo "错误: 下载 Agent 失败"
    echo "请检查网络连接或手动下载: \${DOWNLOAD_URL}"
    exit 1
fi

sudo chmod +x "\${AGENT_DIR}/\${AGENT_BINARY}"

echo "正在创建配置文件..."
sudo tee "\${AGENT_DIR}/.env" > /dev/null <<EOF
GATEWAY_ID=${gatewayId}
API_KEY=${apiKey}
LLM_GATEWAY_URL=${llmGatewayUrl}
PORTKEY_CONTAINER_NAME=portkey-gateway-${gatewayId}
PORTKEY_PORT=${portkeyPort}
AGENT_PORT=${agentPort}
LOG_LEVEL=info
CONFIG_SYNC_INTERVAL=300
HEARTBEAT_INTERVAL=30
EOF

echo "正在创建 systemd 服务..."
sudo tee /etc/systemd/system/llm-gateway-agent.service > /dev/null <<EOF
[Unit]
Description=LLM Gateway Agent
Documentation=https://github.com/sxueck/llm-gateway
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=\${AGENT_DIR}
ExecStart=\${AGENT_DIR}/\${AGENT_BINARY}
Restart=always
RestartSec=10
StartLimitInterval=0
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llm-gateway-agent

[Install]
WantedBy=multi-user.target
EOF

echo "正在启动 Agent 服务..."
sudo systemctl daemon-reload
sudo systemctl enable llm-gateway-agent
sudo systemctl start llm-gateway-agent

echo ""
echo "等待 Agent 启动..."
sleep 3

if sudo systemctl is-active --quiet llm-gateway-agent; then
    echo ""
    echo "=========================================="
    echo "安装成功！"
    echo "=========================================="
    echo ""
    echo "Agent 状态: 运行中"
    echo "Agent 监听端口: ${agentPort}"
    echo "Portkey Gateway 端口: ${portkeyPort}"
    echo ""
    echo "查看 Agent 日志: sudo journalctl -u llm-gateway-agent -f"
    echo "查看 Agent 状态: sudo systemctl status llm-gateway-agent"
    echo "重启 Agent: sudo systemctl restart llm-gateway-agent"
    echo "停止 Agent: sudo systemctl stop llm-gateway-agent"
    echo ""
    echo "查看 Portkey 容器日志: docker logs portkey-gateway-${gatewayId}"
    echo ""
    echo "配置文件位置: \${AGENT_DIR}/.env"
    echo ""
    echo "安装完成！Agent 将自动管理 Portkey Gateway 容器"
else
    echo ""
    echo "错误: Agent 启动失败"
    echo "请查看日志: sudo journalctl -u llm-gateway-agent -n 50"
    exit 1
fi
`;

  return script;
}

export function generateInstallCommand(config: AgentInstallConfig): string {
  const script = generateInstallScript(config);
  const base64Script = Buffer.from(script).toString('base64');
  
  return `echo "${base64Script}" | base64 -d | bash`;
}

