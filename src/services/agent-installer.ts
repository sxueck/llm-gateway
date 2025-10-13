import { appConfig } from '../config/index.js';

export interface AgentInstallConfig {
  gatewayId: string;
  gatewayName: string;
  apiKey: string;
  port: number;
  llmGatewayUrl: string;
}

export function generateInstallScript(config: AgentInstallConfig): string {
  const { gatewayId, gatewayName, apiKey, port, llmGatewayUrl } = config;

  const script = `#!/bin/bash
set -e

echo "=========================================="
echo "Portkey Gateway Agent 安装脚本"
echo "=========================================="
echo ""
echo "网关名称: ${gatewayName}"
echo "网关 ID: ${gatewayId}"
echo "端口: ${port}"
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

CONTAINER_NAME="portkey-gateway-${gatewayId}"
IMAGE="portkeyai/gateway:latest"

echo "正在检查容器是否已存在..."
if docker ps -a --format '{{.Names}}' | grep -q "^\${CONTAINER_NAME}\$"; then
    echo "容器已存在，正在删除旧容器..."
    docker rm -f "\${CONTAINER_NAME}" || true
fi

echo "正在拉取 Docker 镜像..."
docker pull "\${IMAGE}"

echo "正在创建并启动 Portkey Gateway 容器..."
docker run -d \\
  --name "\${CONTAINER_NAME}" \\
  -p ${port}:8787 \\
  -e GATEWAY_ID="${gatewayId}" \\
  -e GATEWAY_API_KEY="${apiKey}" \\
  -e LLM_GATEWAY_URL="${llmGatewayUrl}" \\
  --restart unless-stopped \\
  "\${IMAGE}"

echo ""
echo "等待容器启动..."
sleep 3

if docker ps --format '{{.Names}}' | grep -q "^\${CONTAINER_NAME}\$"; then
    echo ""
    echo "=========================================="
    echo "安装成功！"
    echo "=========================================="
    echo ""
    echo "容器名称: \${CONTAINER_NAME}"
    echo "容器状态: 运行中"
    echo "访问地址: http://localhost:${port}"
    echo ""
    echo "查看日志: docker logs \${CONTAINER_NAME}"
    echo "停止容器: docker stop \${CONTAINER_NAME}"
    echo "启动容器: docker start \${CONTAINER_NAME}"
    echo "删除容器: docker rm -f \${CONTAINER_NAME}"
    echo ""
    
    echo "正在向 LLM Gateway 报告安装状态..."
    curl -X POST "${llmGatewayUrl}/api/agent/report-status" \\
      -H "Content-Type: application/json" \\
      -H "X-Gateway-ID: ${gatewayId}" \\
      -H "X-API-Key: ${apiKey}" \\
      -d '{"status":"installed","port":${port}}' \\
      2>/dev/null || echo "警告: 无法连接到 LLM Gateway，请手动检查网关状态"
    
    echo ""
    echo "安装完成！"
else
    echo ""
    echo "错误: 容器启动失败"
    echo "请查看日志: docker logs \${CONTAINER_NAME}"
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

