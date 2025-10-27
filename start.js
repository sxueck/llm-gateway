#!/usr/bin/env node

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function startLLMGateway() {
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
  console.log('启动 LLM Gateway...\n');

  const llmGateway = startLLMGateway();

  await new Promise(resolve => setTimeout(resolve, 3000));

  const webUI = startWebUI();

  console.log('\n启动完成!');
  console.log('Web UI: http://0.0.0.0:5173');
  console.log('API:    http://0.0.0.0:3000');
  console.log('按 Ctrl+C 停止服务\n');

  process.on('SIGINT', () => {
    console.log('\n正在停止服务...');
    llmGateway.kill();
    webUI.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n正在停止服务...');
    llmGateway.kill();
    webUI.kill();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});

