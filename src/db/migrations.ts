import type { Connection } from 'mysql2/promise';

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
  down?: (conn: Connection) => Promise<void>;
}

// 注意：schema.ts 中已经包含了全部当前需要的表结构和字段。
// 迁移脚本仅保留版本追踪骨架，方便未来新增迁移时扩展。
export const migrations: Migration[] = [
  {
    version: 16,
    name: 'add_backup_and_restore_tables',
    up: async (conn: Connection) => {
      // Create backup_records table
      await conn.query(`
        CREATE TABLE IF NOT EXISTS backup_records (
          id VARCHAR(255) PRIMARY KEY,
          backup_key VARCHAR(255) NOT NULL,
          backup_type ENUM('full', 'incremental') NOT NULL,
          includes_logs TINYINT DEFAULT 0,
          file_size BIGINT,
          file_hash VARCHAR(64),
          s3_key VARCHAR(500) NOT NULL,
          encryption_key_hash VARCHAR(64),
          status ENUM('pending', 'running', 'completed', 'failed') NOT NULL,
          started_at BIGINT,
          completed_at BIGINT,
          error_message TEXT,
          record_count INT,
          checksum VARCHAR(64),
          created_at BIGINT NOT NULL,
          INDEX idx_backup_records_status (status),
          INDEX idx_backup_records_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Create restore_records table
      await conn.query(`
        CREATE TABLE IF NOT EXISTS restore_records (
          id VARCHAR(255) PRIMARY KEY,
          backup_record_id VARCHAR(255) NOT NULL,
          restore_type ENUM('full', 'partial') NOT NULL,
          status ENUM('pending', 'running', 'completed', 'failed', 'rollback') NOT NULL,
          started_at BIGINT,
          completed_at BIGINT,
          error_message TEXT,
          backup_before_restore VARCHAR(255),
          changes_made JSON,
          rollback_data JSON,
          created_at BIGINT NOT NULL,
          FOREIGN KEY (backup_record_id) REFERENCES backup_records(id) ON DELETE CASCADE,
          INDEX idx_restore_records_status (status),
          INDEX idx_restore_records_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
    down: async (conn: Connection) => {
      await conn.query('DROP TABLE IF EXISTS restore_records');
      await conn.query('DROP TABLE IF EXISTS backup_records');
    }
  }
];

export async function getCurrentVersion(conn: Connection): Promise<number> {
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [rows] = await conn.query('SELECT MAX(version) as version FROM schema_migrations');
    const result = rows as any[];
    if (result.length > 0 && result[0].version !== null) {
      console.log(`已应用的迁移版本: v${result[0].version}`);
      return result[0].version;
    }

    console.log('未发现已应用的迁移,数据库版本为 v0');
    return 0;
  } catch (e: any) {
    console.error('获取数据库版本失败:', e.message);
    console.error('错误详情:', e);
    return 0;
  }
}

export async function applyMigrations(conn: Connection): Promise<void> {
  try {
    const currentVersion = await getCurrentVersion(conn);
    console.log(`当前数据库版本: v${currentVersion}`);

    const pendingMigrations = migrations.filter(m => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
      console.log('数据库已是最新版本（由 schema.ts 定义初始结构）');
      return;
    }

    console.log(`发现 ${pendingMigrations.length} 个待应用的迁移`);

    for (const migration of pendingMigrations) {
      await conn.beginTransaction();
      try {
        console.log(`应用迁移 v${migration.version}: ${migration.name}`);
        await migration.up(conn);

        await conn.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          [migration.version, migration.name, Date.now()]
        );

        await conn.commit();
        console.log(`迁移 v${migration.version} 应用成功`);
      } catch (e: any) {
        await conn.rollback();
        console.error(`迁移 v${migration.version} 应用失败:`, e.message);
        console.error('错误详情:', e);
        throw e;
      }
    }

    console.log('所有迁移应用完成');
  } catch (e: any) {
    console.error('迁移系统执行失败:', e.message);
    throw e;
  }
}

export async function rollbackMigration(conn: Connection, targetVersion: number): Promise<void> {
  const currentVersion = await getCurrentVersion(conn);

  if (targetVersion >= currentVersion) {
    console.log('目标版本不低于当前版本，无需回滚');
    return;
  }

  const migrationsToRollback = migrations
    .filter(m => m.version > targetVersion && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version);

  for (const migration of migrationsToRollback) {
    if (!migration.down) {
      console.warn(`迁移 v${migration.version} 没有回滚脚本，跳过`);
      continue;
    }

    try {
      console.log(`回滚迁移 v${migration.version}: ${migration.name}`);
      await migration.down(conn);

      await conn.query('DELETE FROM schema_migrations WHERE version = ?', [migration.version]);

      console.log(`迁移 v${migration.version} 回滚成功`);
    } catch (e) {
      console.error(`迁移 v${migration.version} 回滚失败:`, e);
      throw e;
    }
  }

  console.log('回滚完成');
}
