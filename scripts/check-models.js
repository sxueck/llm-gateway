#!/usr/bin/env node

import initSqlJs from 'sql.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = process.env.DB_PATH || resolve(__dirname, '..', 'data', 'gateway.db');

const SQL = await initSqlJs();
const buffer = await readFile(dbPath);
const db = new SQL.Database(buffer);

console.log('\n=== 所有模型 ===');
const modelsResult = db.exec('SELECT id, name, is_virtual, routing_config_id, expert_routing_id FROM models');
if (modelsResult.length > 0) {
  modelsResult[0].values.forEach(row => {
    console.log(`ID: ${row[0]}, Name: ${row[1]}, Virtual: ${row[2]}, RoutingConfigId: ${row[3]}, ExpertRoutingId: ${row[4]}`);
  });
}

console.log('\n=== 专家路由配置 ===');
const expertRoutingsResult = db.exec('SELECT id, name FROM expert_routing_configs');
if (expertRoutingsResult.length > 0) {
  expertRoutingsResult[0].values.forEach(row => {
    console.log(`ID: ${row[0]}, Name: ${row[1]}`);
  });
}

db.close();

