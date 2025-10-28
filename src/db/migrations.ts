import type { Connection } from 'mysql2/promise';

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
  down?: (conn: Connection) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'extend_expert_routing_logs_text_fields',
    up: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE expert_routing_logs
        MODIFY COLUMN original_request MEDIUMTEXT,
        MODIFY COLUMN classifier_request MEDIUMTEXT,
        MODIFY COLUMN classifier_response MEDIUMTEXT
      `);
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE expert_routing_logs
        MODIFY COLUMN original_request TEXT,
        MODIFY COLUMN classifier_request TEXT,
        MODIFY COLUMN classifier_response TEXT
      `);
    },
  },
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
      return result[0].version;
    }
  } catch (e) {
    console.error('获取数据库版本失败:', e);
  }
  return 0;
}

export async function applyMigrations(conn: Connection): Promise<void> {
  const currentVersion = await getCurrentVersion(conn);
  const pendingMigrations = migrations.filter(m => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    console.log('数据库已是最新版本');
    return;
  }

  console.log(`发现 ${pendingMigrations.length} 个待应用的迁移`);

  for (const migration of pendingMigrations) {
    try {
      console.log(`应用迁移 v${migration.version}: ${migration.name}`);
      await migration.up(conn);

      await conn.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, Date.now()]
      );

      console.log(`迁移 v${migration.version} 应用成功`);
    } catch (e) {
      console.error(`迁移 v${migration.version} 应用失败:`, e);
      throw e;
    }
  }

  console.log('所有迁移应用完成');
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
