import initSqlJs from 'sql.js';
import { readFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import type { Connection } from 'mysql2/promise';

export interface MigrationProgress {
  table: string;
  current: number;
  total: number;
}

export type MigrationProgressCallback = (progress: MigrationProgress) => void;

const BATCH_SIZE = 100;

const TABLE_ORDER = [
  'users',
  'providers',
  'models',
  'virtual_keys',
  'routing_configs',
  'portkey_gateways',
  'model_routing_rules',
  'expert_routing_configs',
  'api_requests',
  'expert_routing_logs',
  'system_config',
];

export async function migrateFromSQLite(
  sqlitePath: string,
  mysqlConnection: Connection,
  onProgress?: MigrationProgressCallback
): Promise<{ success: boolean; message: string; migratedTables: string[] }> {
  const migratedTables: string[] = [];

  try {
    if (!existsSync(sqlitePath)) {
      return {
        success: true,
        message: 'SQLite 数据库文件不存在，跳过迁移',
        migratedTables: [],
      };
    }

    console.log(`[迁移] 开始从 SQLite 迁移数据: ${sqlitePath}`);

    const SQL = await initSqlJs();
    const buffer = await readFile(sqlitePath);
    const db = new SQL.Database(buffer);

    const [rows] = await mysqlConnection.query(
      'SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE()'
    );
    const tableCount = (rows as any)[0].count;

    if (tableCount > 0) {
      const [userRows] = await mysqlConnection.query('SELECT COUNT(*) as count FROM users');
      const userCount = (userRows as any)[0].count;

      if (userCount > 0) {
        console.log('[迁移] MySQL 数据库已包含数据，跳过迁移');
        db.close();
        return {
          success: true,
          message: 'MySQL 数据库已包含数据，跳过迁移',
          migratedTables: [],
        };
      }
    }

    await mysqlConnection.query('SET FOREIGN_KEY_CHECKS = 0');

    for (const tableName of TABLE_ORDER) {
      try {
        const tableExists = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
        
        if (!tableExists || tableExists.length === 0 || tableExists[0].values.length === 0) {
          console.log(`[迁移] 表 ${tableName} 不存在，跳过`);
          continue;
        }

        const result = db.exec(`SELECT * FROM ${tableName}`);
        
        if (!result || result.length === 0 || result[0].values.length === 0) {
          console.log(`[迁移] 表 ${tableName} 为空，跳过`);
          continue;
        }

        const columns = result[0].columns;
        const rows = result[0].values;
        const totalRows = rows.length;

        console.log(`[迁移] 开始迁移表 ${tableName}，共 ${totalRows} 条记录`);

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, Math.min(i + BATCH_SIZE, rows.length));
          
          const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
          const values = batch.flatMap(row => row);
          
          const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${placeholders}`;
          
          await mysqlConnection.query(sql, values);

          if (onProgress) {
            onProgress({
              table: tableName,
              current: Math.min(i + BATCH_SIZE, totalRows),
              total: totalRows,
            });
          }
        }

        console.log(`[迁移] 表 ${tableName} 迁移完成，共 ${totalRows} 条记录`);
        migratedTables.push(tableName);
      } catch (error: any) {
        console.error(`[迁移] 表 ${tableName} 迁移失败:`, error.message);
        throw new Error(`表 ${tableName} 迁移失败: ${error.message}`);
      }
    }

    await mysqlConnection.query('SET FOREIGN_KEY_CHECKS = 1');

    db.close();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = resolve(dirname(sqlitePath), 'backup');
    await mkdir(backupDir, { recursive: true });
    const backupPath = resolve(backupDir, `gateway.db.backup.${timestamp}`);
    
    await rename(sqlitePath, backupPath);
    console.log(`[迁移] SQLite 数据库已备份到: ${backupPath}`);

    return {
      success: true,
      message: `迁移成功，已迁移 ${migratedTables.length} 个表，备份文件: ${backupPath}`,
      migratedTables,
    };
  } catch (error: any) {
    console.error('[迁移] 迁移失败:', error);
    await mysqlConnection.query('SET FOREIGN_KEY_CHECKS = 1');
    
    return {
      success: false,
      message: `迁移失败: ${error.message}`,
      migratedTables,
    };
  }
}

export async function checkMigrationNeeded(sqlitePath: string, mysqlConnection: Connection): Promise<boolean> {
  try {
    if (!existsSync(sqlitePath)) {
      return false;
    }

    const [rows] = await mysqlConnection.query('SELECT COUNT(*) as count FROM users');
    const userCount = (rows as any)[0].count;

    return userCount === 0;
  } catch (error) {
    return true;
  }
}

