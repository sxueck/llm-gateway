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

function startLLMGateway() {
  console.log('\n启动 LLM Gateway...');

  const isWindows = process.platform === 'win32';
  const tsxCmd = isWindows ? 'npx.cmd' : 'npx';

  const llmGateway = spawn(tsxCmd, ['tsx', 'watch', 'src/index.ts'], {
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

  console.log('提示: Portkey Gateway 不再自动启动');
  console.log('您可以通过以下方式管理 Portkey Gateway:');
  console.log('  1. 在 Web UI 的 "Portkey 网关" 页面添加和管理远程网关');
  console.log('  2. 使用 "自动安装 Agent" 功能一键启动本地 Docker 容器');
  console.log('  3. 手动启动 Portkey Gateway 容器并在 Web UI 中配置\n');

  const llmGateway = startLLMGateway();

  await new Promise(resolve => setTimeout(resolve, 3000));

  const webUI = startWebUI();

  console.log('\n========================================');
  console.log('启动完成!');
  console.log('========================================');
  console.log('\n访问地址:');
  console.log('  Web UI:       http://0.0.0.0:5173');
  console.log('  LLM Gateway:  http://0.0.0.0:3000');
  console.log('\n提示: 外部访问请使用服务器的实际 IP 地址或域名');
  console.log('提示: 请在 Web UI 中配置 Portkey Gateway 后使用');
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

