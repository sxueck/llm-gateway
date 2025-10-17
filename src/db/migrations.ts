import { Database as SqlJsDatabase } from 'sql.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: SqlJsDatabase) => void;
  down?: (db: SqlJsDatabase) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'add_smart_routing_support',
    up: (db: SqlJsDatabase) => {
      try {
        db.run('ALTER TABLE models ADD COLUMN is_virtual INTEGER DEFAULT 0');
      } catch (e) {
      }

      try {
        db.run('ALTER TABLE models ADD COLUMN routing_config_id TEXT');
      } catch (e) {
      }

      try {
        db.run('ALTER TABLE models ADD COLUMN model_attributes TEXT');
      } catch (e) {
      }

      try {
        db.run('UPDATE models SET provider_id = NULL WHERE is_virtual = 1');
      } catch (e) {
      }

      db.run('CREATE INDEX IF NOT EXISTS idx_models_is_virtual ON models(is_virtual)');
      db.run('CREATE INDEX IF NOT EXISTS idx_models_routing_config ON models(routing_config_id)');
    },
    down: (db: SqlJsDatabase) => {
    }
  },
  {
    version: 2,
    name: 'add_prompt_management_support',
    up: (db: SqlJsDatabase) => {
      try {
        db.run('ALTER TABLE models ADD COLUMN prompt_config TEXT');
      } catch (e) {
      }

      db.run('CREATE INDEX IF NOT EXISTS idx_models_prompt_config ON models(prompt_config)');
    },
    down: (db: SqlJsDatabase) => {
    }
  }
];

export function getCurrentVersion(db: SqlJsDatabase): number {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    const result = db.exec('SELECT MAX(version) as version FROM schema_migrations');
    if (result.length > 0 && result[0].values.length > 0) {
      const version = result[0].values[0][0];
      return typeof version === 'number' ? version : 0;
    }
  } catch (e) {
    console.error('获取数据库版本失败:', e);
  }
  return 0;
}

export function applyMigrations(db: SqlJsDatabase): void {
  const currentVersion = getCurrentVersion(db);
  const pendingMigrations = migrations.filter(m => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    console.log('数据库已是最新版本');
    return;
  }

  console.log(`发现 ${pendingMigrations.length} 个待应用的迁移`);

  for (const migration of pendingMigrations) {
    try {
      console.log(`应用迁移 v${migration.version}: ${migration.name}`);
      migration.up(db);

      db.run(
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

export function rollbackMigration(db: SqlJsDatabase, targetVersion: number): void {
  const currentVersion = getCurrentVersion(db);

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
      migration.down(db);

      db.run('DELETE FROM schema_migrations WHERE version = ?', [migration.version]);

      console.log(`迁移 v${migration.version} 回滚成功`);
    } catch (e) {
      console.error(`迁移 v${migration.version} 回滚失败:`, e);
      throw e;
    }
  }

  console.log('回滚完成');
}

