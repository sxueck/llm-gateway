#!/usr/bin/env node

const { existsSync } = require('fs');
const { join } = require('path');

const AGENT_DIR = join(__dirname, '..', 'agent');

const requiredBinaries = [
  'llm-gateway-agent-linux-amd64',
  'llm-gateway-agent-darwin-amd64',
  'llm-gateway-agent-darwin-arm64',
];

function checkBinaries() {
  console.log('检查 Agent 二进制文件...');
  
  const missing = [];
  const found = [];

  for (const binary of requiredBinaries) {
    const path = join(AGENT_DIR, binary);
    if (existsSync(path)) {
      found.push(binary);
    } else {
      missing.push(binary);
    }
  }

  if (found.length > 0) {
    console.log('✓ 已找到的二进制文件:');
    found.forEach(b => console.log(`  - ${b}`));
  }

  if (missing.length > 0) {
    console.log('');
    console.log('⚠️  缺少的二进制文件:');
    missing.forEach(b => console.log(`  - ${b}`));
    console.log('');
    console.log('运行以下命令构建:');
    console.log('  npm run build:agent');
    console.log('');
    console.log('或手动构建:');
    console.log(`  cd ${AGENT_DIR}`);
    console.log('  make build-all');
    return false;
  }

  console.log('');
  console.log('✓ 所有必需的二进制文件都已就绪');
  return true;
}

if (require.main === module) {
  const success = checkBinaries();
  process.exit(success ? 0 : 1);
}

module.exports = { checkBinaries };

