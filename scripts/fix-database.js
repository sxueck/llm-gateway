#!/usr/bin/env node

import { existsSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = resolve(__dirname, '..', 'data', 'gateway.db');
const BACKUP_PATH = resolve(__dirname, '..', 'data', `gateway.db.backup.${Date.now()}`);

async function fixDatabase() {
  console.log('========================================');
  console.log('数据库修复工具');
  console.log('========================================\n');

  await mkdir(dirname(DB_PATH), { recursive: true });

  if (!existsSync(DB_PATH)) {
    console.log('✓ 数据库文件不存在，无需修复');
    console.log('  启动应用时将自动创建新数据库\n');
    return;
  }

  console.log(`数据库路径: ${DB_PATH}`);
  console.log(`备份路径: ${BACKUP_PATH}\n`);

  try {
    console.log('正在备份损坏的数据库...');
    renameSync(DB_PATH, BACKUP_PATH);
    console.log('✓ 已备份到:', BACKUP_PATH);
    console.log('✓ 已删除损坏的数据库文件');
    console.log('\n数据库已修复！');
    console.log('启动应用时将自动创建新数据库\n');
    console.log('注意: 旧数据已备份，如需恢复请手动处理\n');
  } catch (error) {
    console.error('✗ 修复失败:', error.message);
    process.exit(1);
  }
}

fixDatabase().catch((error) => {
  console.error('执行失败:', error);
  process.exit(1);
});

