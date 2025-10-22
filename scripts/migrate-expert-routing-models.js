#!/usr/bin/env node

/**
 * 为现有的专家路由配置创建虚拟模型
 */

import initSqlJs from 'sql.js';
import { nanoid } from 'nanoid';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = process.env.DB_PATH || resolve(__dirname, '..', 'data', 'gateway.db');

console.log('========================================');
console.log('专家路由虚拟模型迁移脚本');
console.log('========================================\n');

try {
  const SQL = await initSqlJs();
  const buffer = await readFile(dbPath);
  const db = new SQL.Database(buffer);

  const expertRoutings = db.exec('SELECT * FROM expert_routing_configs');

  if (expertRoutings.length === 0 || !expertRoutings[0].values.length) {
    console.log('没有找到专家路由配置\n');
    process.exit(0);
  }

  const routings = expertRoutings[0].values.map(row => ({
    id: row[0],
    name: row[1],
    description: row[2],
    enabled: row[3],
    config: row[4],
    created_at: row[5],
    updated_at: row[6],
  }));

  console.log(`找到 ${routings.length} 个专家路由配置\n`);

  let createdCount = 0;
  let skippedCount = 0;

  for (const routing of routings) {
    const existingModelResult = db.exec(
      'SELECT * FROM models WHERE expert_routing_id = ?',
      [routing.id]
    );

    if (existingModelResult.length > 0 && existingModelResult[0].values.length > 0) {
      const modelName = existingModelResult[0].values[0][1];
      console.log(`✓ 专家路由 "${routing.name}" 已有虚拟模型: ${modelName}`);
      skippedCount++;
      continue;
    }

    const modelId = nanoid();
    const now = Date.now();

    db.run(`
      INSERT INTO models (
        id, name, provider_id, model_identifier, is_virtual,
        routing_config_id, expert_routing_id, enabled,
        model_attributes, prompt_config, compression_config,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      modelId,
      routing.name,
      null,
      `expert-${routing.id}`,
      1,
      null,
      routing.id,
      1,
      null,
      null,
      null,
      now,
      now
    ]);

    console.log(`✓ 为专家路由 "${routing.name}" 创建虚拟模型`);
    createdCount++;
  }

  const data = db.export();
  await writeFile(dbPath, data);

  db.close();

  console.log('\n========================================');
  console.log('迁移完成!');
  console.log(`创建: ${createdCount} 个虚拟模型`);
  console.log(`跳过: ${skippedCount} 个已存在的模型`);
  console.log('========================================\n');

} catch (error) {
  console.error('迁移失败:', error);
  process.exit(1);
}

