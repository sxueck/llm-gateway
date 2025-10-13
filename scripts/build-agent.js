#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AGENT_DIR = join(__dirname, '..', 'agent');
const VERSION = '1.0.0';

function checkGoInstalled() {
  try {
    execSync('go version', { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

function checkDockerInstalled() {
  try {
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

function buildAgent() {
  console.log('========================================');
  console.log('构建 LLM Gateway Agent');
  console.log(`版本: ${VERSION}`);
  console.log('========================================');
  console.log('');

  if (!checkGoInstalled()) {
    console.log('⚠️  Go 未安装，跳过 Agent 构建');
    console.log('如需构建 Agent，请安装 Go 1.21+: https://golang.org/dl/');
    return false;
  }

  console.log('✓ Go 已安装');

  if (!checkDockerInstalled()) {
    console.log('⚠️  Docker 未安装，Agent 运行时需要 Docker');
    console.log('请安装 Docker: https://docs.docker.com/engine/install/');
  } else {
    console.log('✓ Docker 已安装');
  }

  console.log('');

  try {
    console.log('初始化 Go 依赖...');
    execSync('go mod tidy', {
      cwd: AGENT_DIR,
      stdio: 'inherit',
    });

    console.log('');
    console.log('清理旧文件...');
    try {
      execSync('rm -f llm-gateway-agent llm-gateway-agent-*', {
        cwd: AGENT_DIR,
        stdio: 'pipe',
      });
    } catch (e) {
    }

    const platforms = [
      { os: 'linux', arch: 'amd64', name: 'llm-gateway-agent-linux-amd64' },
    ];

    console.log('');
    for (const platform of platforms) {
      console.log(`构建 ${platform.os}/${platform.arch}...`);
      
      const env = {
        ...process.env,
        GOOS: platform.os,
        GOARCH: platform.arch,
        CGO_ENABLED: '0',
      };

      execSync(
        `go build -o ${platform.name} -ldflags="-s -w -X main.Version=${VERSION}" .`,
        {
          cwd: AGENT_DIR,
          env,
          stdio: 'inherit',
        }
      );
    }

    console.log('');
    console.log('========================================');
    console.log('构建完成！');
    console.log('========================================');
    console.log('');

    try {
      const output = execSync('ls -lh llm-gateway-agent-*', {
        cwd: AGENT_DIR,
        encoding: 'utf-8',
      });
      console.log(output);
    } catch (e) {
    }

    return true;
  } catch (error) {
    console.error('');
    console.error('❌ 构建失败:', error.message);
    console.error('');
    console.error('请检查:');
    console.error('1. Go 版本是否为 1.21+');
    console.error('2. 网络连接是否正常 (需要下载依赖)');
    console.error('3. 磁盘空间是否充足');
    console.error('');
    console.error('手动构建命令:');
    console.error(`  cd ${AGENT_DIR}`);
    console.error('  go mod tidy');
    console.error('  make build-all');
    return false;
  }
}

const success = buildAgent();
process.exit(success ? 0 : 1);

export { buildAgent, checkGoInstalled };
