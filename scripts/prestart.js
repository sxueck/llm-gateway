#!/usr/bin/env node

const { existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

const AGENT_DIR = join(__dirname, '..', 'agent');

function checkGoInstalled() {
  try {
    execSync('go version', { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

function checkAgentBinaries() {
  const binaries = [
    'llm-gateway-agent-linux-amd64',
    'llm-gateway-agent-darwin-amd64',
    'llm-gateway-agent-darwin-arm64',
  ];

  const missing = binaries.filter(b => !existsSync(join(AGENT_DIR, b)));
  return missing.length === 0;
}

function main() {
  console.log('========================================');
  console.log('LLM Gateway 启动前检查');
  console.log('========================================');
  console.log('');

  const goInstalled = checkGoInstalled();
  const binariesExist = checkAgentBinaries();

  if (goInstalled) {
    console.log('✓ Go 已安装');
  } else {
    console.log('⚠️  Go 未安装 (Agent 功能将不可用)');
  }

  if (binariesExist) {
    console.log('✓ Agent 二进制文件已就绪');
  } else {
    console.log('⚠️  Agent 二进制文件缺失');
    
    if (goInstalled) {
      console.log('');
      console.log('正在尝试构建 Agent...');
      try {
        require('./build-agent.js').buildAgent();
      } catch (error) {
        console.log('⚠️  自动构建失败，请手动构建:');
        console.log('  npm run build:agent');
      }
    } else {
      console.log('');
      console.log('请安装 Go 并运行: npm run build:agent');
      console.log('或从发布页面下载预构建的二进制文件');
    }
  }

  console.log('');
  console.log('========================================');
  console.log('');
}

if (require.main === module) {
  main();
}

module.exports = { checkGoInstalled, checkAgentBinaries };

