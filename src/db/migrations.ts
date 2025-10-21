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
  },
  {
    version: 3,
    name: 'add_compression_support',
    up: (db: SqlJsDatabase) => {
      try {
        db.run('ALTER TABLE models ADD COLUMN compression_config TEXT');
      } catch (e) {
      }

      db.run('CREATE INDEX IF NOT EXISTS idx_models_compression_config ON models(compression_config)');
    },
    down: (db: SqlJsDatabase) => {
      try {
        db.run('DROP INDEX IF EXISTS idx_models_compression_config');
      } catch (e) {
      }

      try {
        db.run('ALTER TABLE models DROP COLUMN compression_config');
      } catch (e) {
      }
    }
  },
  {
    version: 4,
    name: 'add_expert_routing_support',
    up: (db: SqlJsDatabase) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS expert_routing_configs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER DEFAULT 1,
          config TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      db.run('CREATE INDEX IF NOT EXISTS idx_expert_routing_configs_enabled ON expert_routing_configs(enabled)');
      db.run('CREATE INDEX IF NOT EXISTS idx_expert_routing_configs_created_at ON expert_routing_configs(created_at)');

      db.run(`
        CREATE TABLE IF NOT EXISTS expert_routing_logs (
          id TEXT PRIMARY KEY,
          virtual_key_id TEXT,
          expert_routing_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          classifier_model TEXT NOT NULL,
          classification_result TEXT NOT NULL,
          selected_expert_id TEXT NOT NULL,
          selected_expert_type TEXT NOT NULL,
          selected_expert_name TEXT NOT NULL,
          classification_time INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE SET NULL,
          FOREIGN KEY (expert_routing_id) REFERENCES expert_routing_configs(id) ON DELETE CASCADE
        )
      `);

      db.run('CREATE INDEX IF NOT EXISTS idx_expert_routing_logs_config ON expert_routing_logs(expert_routing_id)');
      db.run('CREATE INDEX IF NOT EXISTS idx_expert_routing_logs_created_at ON expert_routing_logs(created_at)');
      db.run('CREATE INDEX IF NOT EXISTS idx_expert_routing_logs_category ON expert_routing_logs(classification_result)');

      try {
        db.run('ALTER TABLE models ADD COLUMN expert_routing_id TEXT');
      } catch (e) {
      }

      db.run('CREATE INDEX IF NOT EXISTS idx_models_expert_routing ON models(expert_routing_id)');
    },
    down: (db: SqlJsDatabase) => {
      try {
        db.run('DROP TABLE IF EXISTS expert_routing_logs');
      } catch (e) {
      }

      try {
        db.run('DROP TABLE IF EXISTS expert_routing_configs');
      } catch (e) {
      }

      try {
        db.run('DROP INDEX IF EXISTS idx_models_expert_routing');
      } catch (e) {
      }
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

