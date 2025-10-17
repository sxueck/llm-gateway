import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { appConfig } from '../config/index.js';
import { User, Provider, VirtualKey, SystemConfig } from '../types/index.js';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { applyMigrations } from './migrations.js';

let db: SqlJsDatabase;
let SQL: any;
let isDirty = false;
let saveTimer: NodeJS.Timeout | null = null;
const SAVE_INTERVAL = 5000;

type ApiRequestBuffer = {
  id: string;
  virtual_key_id?: string;
  provider_id?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  status: string;
  response_time?: number;
  error_message?: string;
  request_body?: string;
  response_body?: string;
  cache_hit?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_write_tokens?: number;
};

let apiRequestBuffer: ApiRequestBuffer[] = [];
let bufferFlushTimer: NodeJS.Timeout | null = null;
const BUFFER_FLUSH_INTERVAL = 30000;
const BUFFER_MAX_SIZE = 100;

export async function initDatabase() {
  await mkdir(dirname(appConfig.dbPath), { recursive: true });

  SQL = await initSqlJs();

  const dbPath = resolve(appConfig.dbPath);

  if (existsSync(dbPath)) {
    const buffer = await readFile(dbPath);
    db = new SQL.Database(buffer);

    const integrityCheck = db.exec('PRAGMA integrity_check');
    if (integrityCheck.length === 0 ||
        integrityCheck[0].values[0][0] !== 'ok') {
      console.error('========================================');
      console.error('数据库完整性检查失败');
      console.error('========================================');
      console.error(`数据库路径: ${dbPath}`);
      console.error('');
      console.error('数据库文件已损坏，无法加载。');
      console.error('为防止数据丢失，系统已停止启动。');
      console.error('');
      console.error('请手动处理数据库文件：');
      console.error('  1. 如需修复并重新开始，运行: npm run fix:db');
      console.error('  2. 如需恢复数据，请先备份当前数据库文件');
      console.error('');
      console.error('========================================');
      db.close();
      process.exit(1);
    }
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  createTables();
  applyMigrations(db);
  await saveDatabase();

  startAutoSave();

  return db;
}

async function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  await writeFile(appConfig.dbPath, buffer);
  isDirty = false;
}

function markDirty() {
  isDirty = true;
}

function flushApiRequestBuffer() {
  if (apiRequestBuffer.length === 0) {
    return;
  }

  const now = Date.now();
  const requests = [...apiRequestBuffer];
  apiRequestBuffer = [];

  const failedRequests: ApiRequestBuffer[] = [];

  requests.forEach(request => {
    try {
      db.run(
        `INSERT INTO api_requests (
          id, virtual_key_id, provider_id, model,
          prompt_tokens, completion_tokens, total_tokens,
          status, response_time, error_message, request_body, response_body, cache_hit,
          prompt_cache_hit_tokens, prompt_cache_write_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          request.id,
          request.virtual_key_id || null,
          request.provider_id || null,
          request.model || null,
          request.prompt_tokens || 0,
          request.completion_tokens || 0,
          request.total_tokens || 0,
          request.status,
          request.response_time || null,
          request.error_message || null,
          request.request_body || null,
          request.response_body || null,
          request.cache_hit || 0,
          request.prompt_cache_hit_tokens || 0,
          request.prompt_cache_write_tokens || 0,
          now,
        ]
      );
    } catch (error) {
      console.error(`写入 API 请求日志失败 (ID: ${request.id}):`, error);
      failedRequests.push(request);
    }
  });

  if (failedRequests.length > 0) {
    apiRequestBuffer.unshift(...failedRequests);
  } else {
    markDirty();
  }
}

function startAutoSave() {
  if (saveTimer) {
    clearInterval(saveTimer);
  }

  saveTimer = setInterval(async () => {
    if (isDirty) {
      try {
        await saveDatabase();
      } catch (error) {
        console.error('自动保存数据库失败:', error);
      }
    }
  }, SAVE_INTERVAL);

  if (bufferFlushTimer) {
    clearInterval(bufferFlushTimer);
  }

  bufferFlushTimer = setInterval(() => {
    flushApiRequestBuffer();
  }, BUFFER_FLUSH_INTERVAL);
}

export function flushApiRequestBufferNow() {
  flushApiRequestBuffer();
}

export async function shutdownDatabase() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }

  if (bufferFlushTimer) {
    clearInterval(bufferFlushTimer);
    bufferFlushTimer = null;
  }

  flushApiRequestBuffer();

  if (isDirty) {
    await saveDatabase();
  }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model_mapping TEXT,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT,
      model_identifier TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);

  try {
    db.run('ALTER TABLE models ADD COLUMN is_virtual INTEGER DEFAULT 0');
  } catch (e) {
  }

  try {
    db.run('ALTER TABLE models ADD COLUMN routing_config_id TEXT');
  } catch (e) {
  }

  try {
    db.run('UPDATE models SET provider_id = NULL WHERE is_virtual = 1');
  } catch (e) {
  }

  try {
    db.run('ALTER TABLE models ADD COLUMN model_attributes TEXT');
  } catch (e) {
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled)');
  db.run('CREATE INDEX IF NOT EXISTS idx_models_is_virtual ON models(is_virtual)');

  db.run(`
    CREATE TABLE IF NOT EXISTS virtual_keys (
      id TEXT PRIMARY KEY,
      key_value TEXT NOT NULL UNIQUE,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      routing_strategy TEXT DEFAULT 'single',
      model_ids TEXT,
      routing_config TEXT,
      enabled INTEGER DEFAULT 1,
      rate_limit INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
    )
  `);

  try {
    db.run('ALTER TABLE virtual_keys ADD COLUMN cache_enabled INTEGER DEFAULT 0');
  } catch (e) {
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_virtual_keys_hash ON virtual_keys(key_hash)');
  db.run('CREATE INDEX IF NOT EXISTS idx_virtual_keys_value ON virtual_keys(key_value)');
  db.run('CREATE INDEX IF NOT EXISTS idx_virtual_keys_provider ON virtual_keys(provider_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_virtual_keys_model ON virtual_keys(model_id)');

  db.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS api_requests (
      id TEXT PRIMARY KEY,
      virtual_key_id TEXT,
      provider_id TEXT,
      model TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      status TEXT,
      response_time INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE SET NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL
    )
  `);

  try {
    db.run('ALTER TABLE api_requests ADD COLUMN request_body TEXT');
  } catch (e) {
  }

  try {
    db.run('ALTER TABLE api_requests ADD COLUMN response_body TEXT');
  } catch (e) {
  }

  try {
    db.run('ALTER TABLE api_requests ADD COLUMN cache_hit INTEGER DEFAULT 0');
  } catch (e) {
  }

  try {
    db.run('ALTER TABLE api_requests ADD COLUMN prompt_cache_hit_tokens INTEGER DEFAULT 0');
  } catch (e) {
  }

  try {
    db.run('ALTER TABLE api_requests ADD COLUMN prompt_cache_write_tokens INTEGER DEFAULT 0');
  } catch (e) {
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_api_requests_created_at ON api_requests(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_requests_virtual_key ON api_requests(virtual_key_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_requests_provider ON api_requests(provider_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_requests_status ON api_requests(status)');

  db.run(`
    CREATE TABLE IF NOT EXISTS routing_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_routing_configs_type ON routing_configs(type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_routing_configs_enabled ON routing_configs(enabled)');

  db.run(`
    CREATE TABLE IF NOT EXISTS portkey_gateways (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      is_default INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      container_name TEXT,
      port INTEGER,
      api_key TEXT,
      install_status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  try {
    db.run('ALTER TABLE portkey_gateways ADD COLUMN last_heartbeat INTEGER');
  } catch (e) {
  }

  try {
    db.run('ALTER TABLE portkey_gateways ADD COLUMN agent_version TEXT');
  } catch (e) {
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_portkey_gateways_enabled ON portkey_gateways(enabled)');
  db.run('CREATE INDEX IF NOT EXISTS idx_portkey_gateways_is_default ON portkey_gateways(is_default)');

  db.run(`
    CREATE TABLE IF NOT EXISTS model_routing_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      portkey_gateway_id TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      rule_value TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (portkey_gateway_id) REFERENCES portkey_gateways(id) ON DELETE CASCADE
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_model_routing_rules_gateway ON model_routing_rules(portkey_gateway_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_model_routing_rules_type ON model_routing_rules(rule_type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_model_routing_rules_enabled ON model_routing_rules(enabled)');
  db.run('CREATE INDEX IF NOT EXISTS idx_model_routing_rules_priority ON model_routing_rules(priority)');
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export const userDb = {
  async create(user: Omit<User, 'created_at' | 'updated_at'>): Promise<User> {
    const now = Date.now();
    db.run(
      'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [user.id, user.username, user.password_hash, now, now]
    );
    markDirty();
    return { ...user, created_at: now, updated_at: now };
  },

  findByUsername(username: string): User | undefined {
    const result = db.exec('SELECT * FROM users WHERE username = ?', [username]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      username: row[1] as string,
      password_hash: row[2] as string,
      created_at: row[3] as number,
      updated_at: row[4] as number,
    };
  },

  findById(id: string): User | undefined {
    const result = db.exec('SELECT * FROM users WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      username: row[1] as string,
      password_hash: row[2] as string,
      created_at: row[3] as number,
      updated_at: row[4] as number,
    };
  },
};

export const providerDb = {
  getAll(): Provider[] {
    const result = db.exec('SELECT * FROM providers ORDER BY created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      base_url: row[2] as string,
      api_key: row[3] as string,
      model_mapping: row[4] as string | null,
      enabled: row[5] as number,
      created_at: row[6] as number,
      updated_at: row[7] as number,
    }));
  },

  getById(id: string): Provider | undefined {
    const result = db.exec('SELECT * FROM providers WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      name: row[1] as string,
      base_url: row[2] as string,
      api_key: row[3] as string,
      model_mapping: row[4] as string | null,
      enabled: row[5] as number,
      created_at: row[6] as number,
      updated_at: row[7] as number,
    };
  },

  async create(provider: Omit<Provider, 'created_at' | 'updated_at'>): Promise<Provider> {
    const now = Date.now();
    db.run(
      'INSERT INTO providers (id, name, base_url, api_key, model_mapping, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        provider.id,
        provider.name,
        provider.base_url,
        provider.api_key,
        provider.model_mapping,
        provider.enabled,
        now,
        now
      ]
    );
    markDirty();
    return { ...provider, created_at: now, updated_at: now };
  },

  async update(id: string, updates: Partial<Omit<Provider, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`, values);
    markDirty();
  },

  async delete(id: string): Promise<void> {
    db.run('DELETE FROM providers WHERE id = ?', [id]);
    markDirty();
  },
};

export interface ModelAttributes {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_token_cache_hit?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_tool_choice?: boolean;
  supports_assistant_prefill?: boolean;
  supports_prompt_caching?: boolean;
  supports_reasoning?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_pdf_input?: boolean;
  litellm_provider?: string;
  mode?: string;
}

export interface Model {
  id: string;
  name: string;
  provider_id: string | null;
  model_identifier: string;
  is_virtual: number;
  routing_config_id: string | null;
  enabled: number;
  model_attributes: string | null;
  prompt_config: string | null;
  compression_config: string | null;
  created_at: number;
  updated_at: number;
}

export const modelDb = {
  getAll(): Model[] {
    const result = db.exec('SELECT id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, prompt_config, compression_config, created_at, updated_at FROM models ORDER BY created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      provider_id: row[2] as string | null,
      model_identifier: row[3] as string,
      is_virtual: row[4] as number,
      routing_config_id: row[5] as string | null,
      enabled: row[6] as number,
      model_attributes: row[7] as string | null,
      prompt_config: row[8] as string | null,
      compression_config: row[9] as string | null,
      created_at: row[10] as number,
      updated_at: row[11] as number,
    }));
  },

  getById(id: string): Model | undefined {
    const result = db.exec('SELECT id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, prompt_config, compression_config, created_at, updated_at FROM models WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      name: row[1] as string,
      provider_id: row[2] as string | null,
      model_identifier: row[3] as string,
      is_virtual: row[4] as number,
      routing_config_id: row[5] as string | null,
      enabled: row[6] as number,
      model_attributes: row[7] as string | null,
      prompt_config: row[8] as string | null,
      compression_config: row[9] as string | null,
      created_at: row[10] as number,
      updated_at: row[11] as number,
    };
  },

  getByProviderId(providerId: string): Model[] {
    if (!providerId || typeof providerId !== 'string') {
      console.warn('Invalid providerId parameter');
      return [];
    }

    const result = db.exec('SELECT id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, prompt_config, compression_config, created_at, updated_at FROM models WHERE provider_id = ? ORDER BY created_at DESC', [providerId]);
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      provider_id: row[2] as string | null,
      model_identifier: row[3] as string,
      is_virtual: row[4] as number,
      routing_config_id: row[5] as string | null,
      enabled: row[6] as number,
      model_attributes: row[7] as string | null,
      prompt_config: row[8] as string | null,
      compression_config: row[9] as string | null,
      created_at: row[10] as number,
      updated_at: row[11] as number,
    }));
  },

  async create(model: Omit<Model, 'created_at' | 'updated_at'>): Promise<Model> {
    const now = Date.now();
    db.run(
      'INSERT INTO models (id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, prompt_config, compression_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [model.id, model.name, model.provider_id, model.model_identifier, model.is_virtual, model.routing_config_id, model.enabled, model.model_attributes, model.prompt_config, model.compression_config, now, now]
    );
    markDirty();
    return { ...model, created_at: now, updated_at: now };
  },

  async update(id: string, updates: Partial<Omit<Model, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`, values);
    markDirty();
  },

  async delete(id: string): Promise<void> {
    db.run('DELETE FROM models WHERE id = ?', [id]);
    markDirty();
  },

  countByProviderId(providerId: string): number {
    const result = db.exec('SELECT COUNT(*) as count FROM models WHERE provider_id = ?', [providerId]);
    if (result.length === 0 || result[0].values.length === 0) return 0;
    return result[0].values[0][0] as number;
  },
};

export const virtualKeyDb = {
  getAll(): VirtualKey[] {
    const result = db.exec('SELECT * FROM virtual_keys ORDER BY created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      key_value: row[1] as string,
      key_hash: row[2] as string,
      name: row[3] as string,
      provider_id: row[4] as string | null,
      model_id: row[5] as string | null,
      routing_strategy: row[6] as string,
      model_ids: row[7] as string | null,
      routing_config: row[8] as string | null,
      enabled: row[9] as number,
      rate_limit: row[10] as number | null,
      created_at: row[11] as number,
      updated_at: row[12] as number,
      cache_enabled: (row[13] as number) || 0,
    }));
  },

  getById(id: string): VirtualKey | undefined {
    const result = db.exec('SELECT * FROM virtual_keys WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      key_value: row[1] as string,
      key_hash: row[2] as string,
      name: row[3] as string,
      provider_id: row[4] as string | null,
      model_id: row[5] as string | null,
      routing_strategy: row[6] as string,
      model_ids: row[7] as string | null,
      routing_config: row[8] as string | null,
      enabled: row[9] as number,
      rate_limit: row[10] as number | null,
      created_at: row[11] as number,
      updated_at: row[12] as number,
      cache_enabled: (row[13] as number) || 0,
    };
  },

  getByKeyValue(keyValue: string): VirtualKey | undefined {
    const result = db.exec('SELECT * FROM virtual_keys WHERE key_value = ?', [keyValue]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      key_value: row[1] as string,
      key_hash: row[2] as string,
      name: row[3] as string,
      provider_id: row[4] as string | null,
      model_id: row[5] as string | null,
      routing_strategy: row[6] as string,
      model_ids: row[7] as string | null,
      routing_config: row[8] as string | null,
      enabled: row[9] as number,
      rate_limit: row[10] as number | null,
      created_at: row[11] as number,
      updated_at: row[12] as number,
      cache_enabled: (row[13] as number) || 0,
    };
  },

  async create(vk: Omit<VirtualKey, 'created_at' | 'updated_at'>): Promise<VirtualKey> {
    const now = Date.now();
    db.run(
      `INSERT INTO virtual_keys (
        id, key_value, key_hash, name, provider_id, model_id,
        routing_strategy, model_ids, routing_config,
        enabled, rate_limit, cache_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vk.id,
        vk.key_value,
        vk.key_hash,
        vk.name,
        vk.provider_id || null,
        vk.model_id || null,
        vk.routing_strategy || 'single',
        vk.model_ids || null,
        vk.routing_config || null,
        vk.enabled,
        vk.rate_limit,
        vk.cache_enabled || 0,
        now,
        now
      ]
    );
    markDirty();
    return { ...vk, created_at: now, updated_at: now };
  },

  async update(id: string, updates: Partial<Omit<VirtualKey, 'id' | 'key_value' | 'key_hash' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(`UPDATE virtual_keys SET ${fields.join(', ')} WHERE id = ?`, values);
    markDirty();
  },

  async delete(id: string): Promise<void> {
    db.run('DELETE FROM virtual_keys WHERE id = ?', [id]);
    markDirty();
  },

  countByModelId(modelId: string): number {
    const result = db.exec(
      `SELECT COUNT(*) as count FROM virtual_keys
       WHERE model_id = ? OR model_ids LIKE ?`,
      [modelId, `%"${modelId}"%`]
    );
    if (result.length === 0 || result[0].values.length === 0) return 0;
    return result[0].values[0][0] as number;
  },

  countByModelIds(modelIds: string[]): Map<string, number> {
    if (modelIds.length === 0) {
      return new Map();
    }

    const counts = new Map<string, number>();
    modelIds.forEach(id => counts.set(id, 0));

    const placeholders = modelIds.map(() => '?').join(',');
    const likeConditions = modelIds.map(() => 'model_ids LIKE ?').join(' OR ');

    const result = db.exec(
      `SELECT model_id, COUNT(*) as count FROM virtual_keys
       WHERE model_id IN (${placeholders})
       GROUP BY model_id`,
      modelIds
    );

    if (result.length > 0 && result[0].values.length > 0) {
      result[0].values.forEach(row => {
        const modelId = row[0] as string;
        const count = row[1] as number;
        counts.set(modelId, count);
      });
    }

    const likeParams: string[] = [];
    modelIds.forEach(id => {
      const escapedId = id.replace(/["%]/g, '\\$&');
      likeParams.push(`%"${escapedId}"%`);
    });

    const likeResult = db.exec(
      `SELECT model_ids FROM virtual_keys
       WHERE model_ids IS NOT NULL AND (${likeConditions})`,
      likeParams
    );

    if (likeResult.length > 0 && likeResult[0].values.length > 0) {
      likeResult[0].values.forEach(row => {
        const modelIdsStr = row[0] as string;
        try {
          const parsedIds = JSON.parse(modelIdsStr);
          if (Array.isArray(parsedIds)) {
            parsedIds.forEach(id => {
              if (counts.has(id)) {
                counts.set(id, (counts.get(id) || 0) + 1);
              }
            });
          }
        } catch {
        }
      });
    }

    return counts;
  },
};

export const systemConfigDb = {
  get(key: string): SystemConfig | undefined {
    const result = db.exec('SELECT * FROM system_config WHERE key = ?', [key]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      key: row[0] as string,
      value: row[1] as string,
      description: row[2] as string | null,
      updated_at: row[3] as number,
    };
  },

  async set(key: string, value: string, description?: string): Promise<void> {
    const now = Date.now();
    const existing = this.get(key);

    if (existing) {
      db.run(
        'UPDATE system_config SET value = ?, description = ?, updated_at = ? WHERE key = ?',
        [value, description || null, now, key]
      );
    } else {
      db.run(
        'INSERT INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, ?)',
        [key, value, description || null, now]
      );
    }
    markDirty();
  },
};

export const apiRequestDb = {
  async create(request: ApiRequestBuffer): Promise<void> {
    apiRequestBuffer.push(request);

    if (apiRequestBuffer.length >= BUFFER_MAX_SIZE) {
      flushApiRequestBuffer();
    }
  },

  getStats(options?: { startTime?: number; endTime?: number }) {
    const now = Date.now();
    const startTime = options?.startTime || now - 24 * 60 * 60 * 1000;
    const endTime = options?.endTime || now;

    const result = db.exec(
      `SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_requests,
        SUM(CASE WHEN cache_hit = 0 THEN total_tokens ELSE 0 END) as total_tokens,
        AVG(response_time) as avg_response_time,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits,
        SUM(CASE WHEN cache_hit = 1 THEN total_tokens ELSE 0 END) as cache_saved_tokens
      FROM api_requests
      WHERE created_at >= ? AND created_at <= ?`,
      [startTime, endTime]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalTokens: 0,
        avgResponseTime: 0,
        cacheHits: 0,
        cacheSavedTokens: 0,
      };
    }

    const row = result[0].values[0];
    return {
      totalRequests: (row[0] as number) || 0,
      successfulRequests: (row[1] as number) || 0,
      failedRequests: (row[2] as number) || 0,
      totalTokens: (row[3] as number) || 0,
      avgResponseTime: (row[4] as number) || 0,
      cacheHits: (row[5] as number) || 0,
      cacheSavedTokens: (row[6] as number) || 0,
    };
  },

  getByVirtualKey(virtualKeyId: string, limit: number = 100) {
    const result = db.exec(
      `SELECT * FROM api_requests
       WHERE virtual_key_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [virtualKeyId, limit]
    );

    if (result.length === 0) return [];

    return result[0].values.map(row => ({
      id: row[0] as string,
      virtual_key_id: row[1] as string | null,
      provider_id: row[2] as string | null,
      model: row[3] as string | null,
      prompt_tokens: row[4] as number,
      completion_tokens: row[5] as number,
      total_tokens: row[6] as number,
      status: row[7] as string,
      response_time: row[8] as number | null,
      error_message: row[9] as string | null,
      created_at: row[10] as number,
      request_body: row[11] as string | null,
      response_body: row[12] as string | null,
      prompt_cache_hit_tokens: row[13] as number,
      prompt_cache_write_tokens: row[14] as number,
    }));
  },

  getTrend(options?: { startTime?: number; endTime?: number; interval?: 'hour' | 'day' }) {
    const now = Date.now();
    const startTime = options?.startTime || now - 24 * 60 * 60 * 1000;
    const endTime = options?.endTime || now;
    const interval = options?.interval || 'hour';

    const intervalMs = interval === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    const result = db.exec(
      `SELECT
        (created_at / ${intervalMs}) * ${intervalMs} as time_bucket,
        COUNT(*) as request_count,
        SUM(total_tokens) as token_count
      FROM api_requests
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY time_bucket
      ORDER BY time_bucket ASC`,
      [startTime, endTime]
    );

    if (result.length === 0) return [];

    return result[0].values.map(row => ({
      timestamp: row[0] as number,
      requestCount: row[1] as number,
      tokenCount: (row[2] as number) || 0,
    }));
  },

  getAll(options?: {
    page?: number;
    pageSize?: number;
    startTime?: number;
    endTime?: number;
    status?: string;
    virtualKeyId?: string;
    providerId?: string;
    model?: string;
  }) {
    const page = options?.page || 1;
    const pageSize = options?.pageSize || 20;
    const offset = (page - 1) * pageSize;

    let whereConditions: string[] = [];
    let params: any[] = [];

    if (options?.startTime) {
      whereConditions.push('created_at >= ?');
      params.push(options.startTime);
    }

    if (options?.endTime) {
      whereConditions.push('created_at <= ?');
      params.push(options.endTime);
    }

    if (options?.status) {
      whereConditions.push('status = ?');
      params.push(options.status);
    }

    if (options?.virtualKeyId) {
      whereConditions.push('virtual_key_id = ?');
      params.push(options.virtualKeyId);
    }

    if (options?.providerId) {
      whereConditions.push('provider_id = ?');
      params.push(options.providerId);
    }

    if (options?.model) {
      whereConditions.push('model = ?');
      params.push(options.model);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const countResult = db.exec(
      `SELECT COUNT(*) as total FROM api_requests ${whereClause}`,
      params
    );
    const total = countResult.length > 0 && countResult[0].values.length > 0
      ? (countResult[0].values[0][0] as number)
      : 0;

    const result = db.exec(
      `SELECT * FROM api_requests ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    if (result.length === 0) {
      return {
        data: [],
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }

    const data = result[0].values.map(row => ({
      id: row[0] as string,
      virtual_key_id: row[1] as string | null,
      provider_id: row[2] as string | null,
      model: row[3] as string | null,
      prompt_tokens: row[4] as number,
      completion_tokens: row[5] as number,
      total_tokens: row[6] as number,
      status: row[7] as string,
      response_time: row[8] as number | null,
      error_message: row[9] as string | null,
      created_at: row[10] as number,
      request_body: row[11] as string | null,
      response_body: row[12] as string | null,
      prompt_cache_hit_tokens: row[13] as number,
      prompt_cache_write_tokens: row[14] as number,
    }));

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  },

  getById(id: string) {
    const result = db.exec('SELECT * FROM api_requests WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      id: row[0] as string,
      virtual_key_id: row[1] as string | null,
      provider_id: row[2] as string | null,
      model: row[3] as string | null,
      prompt_tokens: row[4] as number,
      completion_tokens: row[5] as number,
      total_tokens: row[6] as number,
      status: row[7] as string,
      response_time: row[8] as number | null,
      error_message: row[9] as string | null,
      created_at: row[10] as number,
      request_body: row[11] as string | null,
      response_body: row[12] as string | null,
      prompt_cache_hit_tokens: row[13] as number,
      prompt_cache_write_tokens: row[14] as number,
    };
  },

  async cleanOldRecords(daysToKeep: number = 30): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const countResult = db.exec(
      'SELECT COUNT(*) as count FROM api_requests WHERE created_at < ?',
      [cutoffTime]
    );
    const count = countResult.length > 0 && countResult[0].values.length > 0
      ? (countResult[0].values[0][0] as number)
      : 0;

    if (count > 0) {
      db.run('DELETE FROM api_requests WHERE created_at < ?', [cutoffTime]);
      markDirty();
    }

    return count;
  },
};

export const routingConfigDb = {
  getAll() {
    const result = db.exec('SELECT * FROM routing_configs ORDER BY created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      description: row[2] as string | null,
      type: row[3] as string,
      config: row[4] as string,
      enabled: row[5] as number,
      created_at: row[6] as number,
      updated_at: row[7] as number,
    }));
  },

  getById(id: string) {
    const result = db.exec('SELECT * FROM routing_configs WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      name: row[1] as string,
      description: row[2] as string | null,
      type: row[3] as string,
      config: row[4] as string,
      enabled: row[5] as number,
      created_at: row[6] as number,
      updated_at: row[7] as number,
    };
  },

  async create(data: {
    id: string;
    name: string;
    description?: string;
    type: string;
    config: string;
    enabled?: number;
  }) {
    const now = Date.now();
    db.run(
      `INSERT INTO routing_configs (id, name, description, type, config, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.name,
        data.description || null,
        data.type,
        data.config,
        data.enabled ?? 1,
        now,
        now,
      ]
    );
    markDirty();
    return this.getById(data.id);
  },

  async update(id: string, data: {
    name?: string;
    description?: string;
    type?: string;
    config?: string;
    enabled?: number;
  }) {
    const now = Date.now();
    const updates: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      values.push(data.description);
    }
    if (data.type !== undefined) {
      updates.push('type = ?');
      values.push(data.type);
    }
    if (data.config !== undefined) {
      updates.push('config = ?');
      values.push(data.config);
    }
    if (data.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(data.enabled);
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(
      `UPDATE routing_configs SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    markDirty();
    return this.getById(id);
  },

  async delete(id: string) {
    db.run('DELETE FROM routing_configs WHERE id = ?', [id]);
    markDirty();
  },
};

function mapPortkeyGatewayRow(row: any[]) {
  return {
    id: row[0] as string,
    name: row[1] as string,
    url: row[2] as string,
    description: row[3] as string | null,
    is_default: row[4] as number,
    enabled: row[5] as number,
    container_name: row[6] as string | null,
    port: row[7] as number | null,
    api_key: row[8] as string | null,
    install_status: row[9] as string | null,
    created_at: row[10] as number,
    updated_at: row[11] as number,
    last_heartbeat: row[12] as number | null,
    agent_version: row[13] as string | null,
  };
}

export const portkeyGatewayDb = {
  getAll() {
    const result = db.exec('SELECT * FROM portkey_gateways ORDER BY is_default DESC, created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(mapPortkeyGatewayRow);
  },

  getById(id: string) {
    const result = db.exec('SELECT * FROM portkey_gateways WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    return mapPortkeyGatewayRow(result[0].values[0]);
  },

  getDefault() {
    const result = db.exec('SELECT * FROM portkey_gateways WHERE is_default = 1 AND enabled = 1 LIMIT 1');
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    return mapPortkeyGatewayRow(result[0].values[0]);
  },

  getEnabled() {
    const result = db.exec('SELECT * FROM portkey_gateways WHERE enabled = 1 ORDER BY is_default DESC, created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(mapPortkeyGatewayRow);
  },

  async create(data: {
    id: string;
    name: string;
    url: string;
    description?: string;
    is_default?: number;
    enabled?: number;
    container_name?: string;
    port?: number;
    api_key?: string;
    install_status?: string;
    last_heartbeat?: number;
    agent_version?: string;
  }) {
    const now = Date.now();

    if (data.is_default === 1) {
      db.run('UPDATE portkey_gateways SET is_default = 0');
    }

    db.run(
      `INSERT INTO portkey_gateways (id, name, url, description, is_default, enabled, container_name, port, api_key, install_status, last_heartbeat, agent_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.name,
        data.url,
        data.description || null,
        data.is_default ?? 0,
        data.enabled ?? 1,
        data.container_name || null,
        data.port || null,
        data.api_key || null,
        data.install_status || 'pending',
        data.last_heartbeat || null,
        data.agent_version || null,
        now,
        now,
      ]
    );
    markDirty();
    return this.getById(data.id);
  },

  async update(id: string, data: {
    name?: string;
    url?: string;
    description?: string;
    is_default?: number;
    enabled?: number;
    container_name?: string;
    port?: number;
    api_key?: string;
    install_status?: string;
    last_heartbeat?: number;
    agent_version?: string;
  }) {
    const now = Date.now();
    const updates: string[] = [];
    const values: any[] = [];

    if (data.is_default === 1) {
      db.run('UPDATE portkey_gateways SET is_default = 0');
    }

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.url !== undefined) {
      updates.push('url = ?');
      values.push(data.url);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      values.push(data.description);
    }
    if (data.is_default !== undefined) {
      updates.push('is_default = ?');
      values.push(data.is_default);
    }
    if (data.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(data.enabled);
    }
    if (data.container_name !== undefined) {
      updates.push('container_name = ?');
      values.push(data.container_name);
    }
    if (data.port !== undefined) {
      updates.push('port = ?');
      values.push(data.port);
    }
    if (data.api_key !== undefined) {
      updates.push('api_key = ?');
      values.push(data.api_key);
    }
    if (data.install_status !== undefined) {
      updates.push('install_status = ?');
      values.push(data.install_status);
    }
    if (data.last_heartbeat !== undefined) {
      updates.push('last_heartbeat = ?');
      values.push(data.last_heartbeat);
    }
    if (data.agent_version !== undefined) {
      updates.push('agent_version = ?');
      values.push(data.agent_version);
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(
      `UPDATE portkey_gateways SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    markDirty();
    return this.getById(id);
  },

  async delete(id: string) {
    db.run('DELETE FROM portkey_gateways WHERE id = ?', [id]);
    markDirty();
  },
};

export const modelRoutingRuleDb = {
  getAll() {
    const result = db.exec('SELECT * FROM model_routing_rules ORDER BY priority DESC, created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      description: row[2] as string | null,
      portkey_gateway_id: row[3] as string,
      rule_type: row[4] as string,
      rule_value: row[5] as string,
      priority: row[6] as number,
      enabled: row[7] as number,
      created_at: row[8] as number,
      updated_at: row[9] as number,
    }));
  },

  getById(id: string) {
    const result = db.exec('SELECT * FROM model_routing_rules WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      name: row[1] as string,
      description: row[2] as string | null,
      portkey_gateway_id: row[3] as string,
      rule_type: row[4] as string,
      rule_value: row[5] as string,
      priority: row[6] as number,
      enabled: row[7] as number,
      created_at: row[8] as number,
      updated_at: row[9] as number,
    };
  },

  getByGatewayId(gatewayId: string) {
    const result = db.exec('SELECT * FROM model_routing_rules WHERE portkey_gateway_id = ? ORDER BY priority DESC', [gatewayId]);
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      description: row[2] as string | null,
      portkey_gateway_id: row[3] as string,
      rule_type: row[4] as string,
      rule_value: row[5] as string,
      priority: row[6] as number,
      enabled: row[7] as number,
      created_at: row[8] as number,
      updated_at: row[9] as number,
    }));
  },

  getEnabled() {
    const result = db.exec('SELECT * FROM model_routing_rules WHERE enabled = 1 ORDER BY priority DESC, created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      description: row[2] as string | null,
      portkey_gateway_id: row[3] as string,
      rule_type: row[4] as string,
      rule_value: row[5] as string,
      priority: row[6] as number,
      enabled: row[7] as number,
      created_at: row[8] as number,
      updated_at: row[9] as number,
    }));
  },

  async create(data: {
    id: string;
    name: string;
    description?: string;
    portkey_gateway_id: string;
    rule_type: string;
    rule_value: string;
    priority?: number;
    enabled?: number;
  }) {
    const now = Date.now();
    db.run(
      `INSERT INTO model_routing_rules (id, name, description, portkey_gateway_id, rule_type, rule_value, priority, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.name,
        data.description || null,
        data.portkey_gateway_id,
        data.rule_type,
        data.rule_value,
        data.priority ?? 0,
        data.enabled ?? 1,
        now,
        now,
      ]
    );
    markDirty();
    return this.getById(data.id);
  },

  async update(id: string, data: {
    name?: string;
    description?: string;
    portkey_gateway_id?: string;
    rule_type?: string;
    rule_value?: string;
    priority?: number;
    enabled?: number;
  }) {
    const now = Date.now();
    const updates: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      values.push(data.description);
    }
    if (data.portkey_gateway_id !== undefined) {
      updates.push('portkey_gateway_id = ?');
      values.push(data.portkey_gateway_id);
    }
    if (data.rule_type !== undefined) {
      updates.push('rule_type = ?');
      values.push(data.rule_type);
    }
    if (data.rule_value !== undefined) {
      updates.push('rule_value = ?');
      values.push(data.rule_value);
    }
    if (data.priority !== undefined) {
      updates.push('priority = ?');
      values.push(data.priority);
    }
    if (data.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(data.enabled);
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(
      `UPDATE model_routing_rules SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    markDirty();
    return this.getById(id);
  },

  async delete(id: string) {
    db.run('DELETE FROM model_routing_rules WHERE id = ?', [id]);
    markDirty();
  },
};

