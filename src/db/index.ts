import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { appConfig } from '../config/index.js';
import { User, Provider, VirtualKey, SystemConfig } from '../types/index.js';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

let db: SqlJsDatabase;
let SQL: any;

export async function initDatabase() {
  await mkdir(dirname(appConfig.dbPath), { recursive: true });

  SQL = await initSqlJs();

  const dbPath = resolve(appConfig.dbPath);

  if (existsSync(dbPath)) {
    const buffer = await readFile(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  createTables();
  await saveDatabase();

  return db;
}

async function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  await writeFile(appConfig.dbPath, buffer);
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
    await saveDatabase();
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
    await saveDatabase();
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
    await saveDatabase();
  },

  async delete(id: string): Promise<void> {
    db.run('DELETE FROM providers WHERE id = ?', [id]);
    await saveDatabase();
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
  created_at: number;
  updated_at: number;
}

export const modelDb = {
  getAll(): Model[] {
    const result = db.exec('SELECT id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, created_at, updated_at FROM models ORDER BY created_at DESC');
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
      created_at: row[8] as number,
      updated_at: row[9] as number,
    }));
  },

  getById(id: string): Model | undefined {
    const result = db.exec('SELECT id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, created_at, updated_at FROM models WHERE id = ?', [id]);
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
      created_at: row[8] as number,
      updated_at: row[9] as number,
    };
  },

  getByProviderId(providerId: string): Model[] {
    const result = db.exec('SELECT id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, created_at, updated_at FROM models WHERE provider_id = ? ORDER BY created_at DESC', [providerId]);
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
      created_at: row[8] as number,
      updated_at: row[9] as number,
    }));
  },

  async create(model: Omit<Model, 'created_at' | 'updated_at'>): Promise<Model> {
    const now = Date.now();
    db.run(
      'INSERT INTO models (id, name, provider_id, model_identifier, is_virtual, routing_config_id, enabled, model_attributes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [model.id, model.name, model.provider_id, model.model_identifier, model.is_virtual, model.routing_config_id, model.enabled, model.model_attributes, now, now]
    );
    await saveDatabase();
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
    await saveDatabase();
  },

  async delete(id: string): Promise<void> {
    db.run('DELETE FROM models WHERE id = ?', [id]);
    await saveDatabase();
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
    await saveDatabase();
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
    await saveDatabase();
  },

  async delete(id: string): Promise<void> {
    db.run('DELETE FROM virtual_keys WHERE id = ?', [id]);
    await saveDatabase();
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
    await saveDatabase();
  },
};

export const apiRequestDb = {
  async create(request: {
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
  }): Promise<void> {
    const now = Date.now();
    db.run(
      `INSERT INTO api_requests (
        id, virtual_key_id, provider_id, model,
        prompt_tokens, completion_tokens, total_tokens,
        status, response_time, error_message, request_body, response_body, cache_hit, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
      ]
    );
    await saveDatabase();
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
        SUM(total_tokens) as total_tokens,
        AVG(response_time) as avg_response_time,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits
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
      await saveDatabase();
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
    await saveDatabase();
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
    await saveDatabase();
    return this.getById(id);
  },

  async delete(id: string) {
    db.run('DELETE FROM routing_configs WHERE id = ?', [id]);
    await saveDatabase();
  },
};

