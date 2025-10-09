#!/usr/bin/env node

/**
 * LLM Gateway 一键启动脚本
 * 自动启动 Portkey Gateway 和 LLM Gateway
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTKEY_CONTAINER_NAME = 'portkey-gateway';
const PORTKEY_PORT = 8787;
const PORTKEY_IMAGE = 'portkeyai/gateway:latest';

async function checkPortkeyContainer() {
  try {
    const { stdout } = await execAsync(
      `docker ps -a --filter "name=${PORTKEY_CONTAINER_NAME}" --format "{{.ID}}|{{.Status}}"`
    );

    if (!stdout.trim()) {
      return { exists: false, running: false };
    }

    const [containerId, status] = stdout.trim().split('|');
    const isRunning = status.toLowerCase().includes('up');

    return {
      exists: true,
      running: isRunning,
      containerId,
      status,
    };
  } catch (error) {
    return { exists: false, running: false };
  }
}

async function startPortkeyGateway() {
  console.log('\n启动 Portkey Gateway...');

  const containerStatus = await checkPortkeyContainer();

  if (containerStatus.running) {
    console.log('✓ Portkey Gateway 已在运行中');
    return true;
  }

  try {
    if (containerStatus.exists) {
      console.log('启动已存在的容器...');
      await execAsync(`docker start ${PORTKEY_CONTAINER_NAME}`);
    } else {
      console.log('创建并启动新容器...');
      
      const configDir = resolve(__dirname, 'portkey-config');
      const isWindows = process.platform === 'win32';
      const volumePath = isWindows
        ? configDir.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive) => `/${drive.toLowerCase()}`)
        : configDir;

      const filePathRaw = resolve(configDir, 'conf.json');
      const fileVolumePath = isWindows
        ? filePathRaw.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive) => `/${drive.toLowerCase()}`)
        : filePathRaw;

      const command = [
        'docker run -d',
        `--name ${PORTKEY_CONTAINER_NAME}`,
        `-p 127.0.0.1:${PORTKEY_PORT}:8787`,
        `-v "${volumePath}:/app/config"`,
        `-v "${fileVolumePath}:/app/conf.json"`,
        '-e CONFIG_PATH=/app/config/conf.json',
        '--restart unless-stopped',
        PORTKEY_IMAGE,
      ].join(' ');

      console.log(`执行命令: ${command}`);
      await execAsync(command);
    }

    await waitForPortkeyHealthy();
    console.log('✓ Portkey Gateway 启动成功');
    return true;
  } catch (error) {
    console.error('✗ Portkey Gateway 启动失败:', error.message);
    return false;
  }
}

async function waitForPortkeyHealthy(timeout = 10000) {
  console.log('等待 Portkey Gateway 就绪...');
  const startTime = Date.now();
  const checkInterval = 500;

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(`http://localhost:${PORTKEY_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });

      if (response.ok || response.status === 404) {
        return true;
      }
    } catch (error) {
      // 继续等待
    }

    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  throw new Error('Portkey Gateway 健康检查超时');
}

function startLLMGateway() {
  console.log('\n启动 LLM Gateway...');
  
  const isWindows = process.platform === 'win32';
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';

  const llmGateway = spawn(npmCmd, ['run', 'dev'], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: true,
  });

  llmGateway.on('error', (error) => {
    console.error('✗ LLM Gateway 启动失败:', error);
    process.exit(1);
  });

  return llmGateway;
}

function startWebUI() {
  console.log('\n启动 Web UI...');
  
  const isWindows = process.platform === 'win32';
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';

  const webUI = spawn(npmCmd, ['run', 'dev'], {
    cwd: resolve(__dirname, 'web'),
    stdio: 'inherit',
    shell: true,
  });

  webUI.on('error', (error) => {
    console.error('✗ Web UI 启动失败:', error);
    process.exit(1);
  });

  return webUI;
}

async function main() {
  console.log('========================================');
  console.log('LLM Gateway 启动脚本');
  console.log('========================================\n');

  const portkeyStarted = await startPortkeyGateway();
  if (!portkeyStarted) {
    console.log('\n提示: Portkey Gateway 启动失败');
    console.log('您可以稍后在 Web UI 中启动，或手动启动');
  }

  const llmGateway = startLLMGateway();

  await new Promise(resolve => setTimeout(resolve, 3000));

  const webUI = startWebUI();

  console.log('\n========================================');
  console.log('启动完成!');
  console.log('========================================');
  console.log('\n访问地址:');
  console.log('  Web UI:          http://0.0.0.0:5173');
  console.log('  LLM Gateway:     http://0.0.0.0:3000');
  console.log('  Portkey Gateway: http://localhost:8787');
  console.log('\n提示: 外部访问请使用服务器的实际 IP 地址或域名');
  console.log('按 Ctrl+C 停止所有服务\n');

  process.on('SIGINT', () => {
    console.log('\n\n正在停止服务...');
    llmGateway.kill();
    webUI.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n\n正在停止服务...');
    llmGateway.kill();
    webUI.kill();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});

