import mysql from 'mysql2/promise';
import { appConfig } from '../config/index.js';
import { User, Provider, VirtualKey, SystemConfig } from '../types/index.js';
import { applyMigrations } from './migrations.js';

let pool: mysql.Pool;

type ApiRequestBuffer = {
  id: string;
  virtual_key_id?: string;
  provider_id?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  status: string;
  response_time?: number;
  error_message?: string;
  request_body?: string;
  response_body?: string;
  cache_hit?: number;
  request_type?: string;
  compression_original_tokens?: number;
  compression_saved_tokens?: number;
};

export interface Model {
  id: string;
  name: string;
  provider_id: string | null;
  model_identifier: string;
  protocol: string | null; // 'openai' | 'anthropic' | 'google' - 模型级别的协议声明
  is_virtual: number;
  routing_config_id: string | null;
  expert_routing_id?: string | null;
  enabled: number;
  model_attributes: string | null;
  prompt_config: string | null;
  compression_config: string | null;
  created_at: number;
  updated_at: number;
}

let apiRequestBuffer: ApiRequestBuffer[] = [];
let bufferFlushTimer: NodeJS.Timeout | null = null;
const BUFFER_FLUSH_INTERVAL = 10000;
const BUFFER_MAX_SIZE = 200;

function getDisableLoggingCondition(): string {
  return '(ar.virtual_key_id IS NULL OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)';
}

function generateTimeBuckets(startTime: number, endTime: number, intervalMs: number): number[] {
  const timePoints: number[] = [];
  let currentTime = Math.floor(startTime / intervalMs) * intervalMs;
  const endBucket = Math.floor(endTime / intervalMs) * intervalMs;

  while (currentTime <= endBucket) {
    timePoints.push(currentTime);
    currentTime += intervalMs;
  }

  return timePoints;
}

function initializeTimeBuckets(timePoints: number[]): Map<number, any> {
  const buckets = new Map<number, any>();
  timePoints.forEach(time => {
    buckets.set(time, {
      timestamp: time,
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      tokenCount: 0
    });
  });
  return buckets;
}

export async function initDatabase() {
  try {
    pool = mysql.createPool({
      host: appConfig.mysql.host,
      port: appConfig.mysql.port,
      user: appConfig.mysql.user,
      password: appConfig.mysql.password,
      database: appConfig.mysql.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });

    const connection = await pool.getConnection();
    console.log('[数据库] MySQL 连接成功');

    console.log('[数据库] 开始创建表结构...');
    await createTables();
    console.log('[数据库] 表结构创建完成');

    console.log('[数据库] 开始应用数据库迁移...');
    try {
      await applyMigrations(connection as any);
      console.log('[数据库] 数据库迁移完成');
    } catch (migrationError: any) {
      console.error('[数据库] 迁移失败:', migrationError.message);
      console.error('[数据库] 迁移错误详情:', migrationError);
      throw migrationError;
    }

    connection.release();
    startBufferFlush();

    return pool;
  } catch (error: any) {
    console.error('[数据库] 初始化失败:', error.message);
    console.error('[数据库] 错误详情:', error);
    throw new Error(`数据库初始化失败: ${error.message}`);
  }
}

function startBufferFlush() {
  if (bufferFlushTimer) {
    clearInterval(bufferFlushTimer);
  }

  bufferFlushTimer = setInterval(() => {
    flushApiRequestBuffer();
  }, BUFFER_FLUSH_INTERVAL);
}

/**
 * 计算字符串的 UTF-8 字节长度
 */
function getByteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

/**
 * 按字节长度截断字符串，确保不会超过指定的字节数
 * 同时确保不会在 UTF-8 多字节字符中间截断
 */
function truncateToByteLength(str: string, maxBytes: number): string {
  if (getByteLength(str) <= maxBytes) {
    return str;
  }

  // 预留一些空间给截断标记
  const suffix = '...[truncated]';
  const suffixBytes = getByteLength(suffix);
  const targetBytes = maxBytes - suffixBytes;

  // 使用二分查找找到合适的截断点
  let low = 0;
  let high = str.length;
  let result = '';

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const substr = str.substring(0, mid);
    if (getByteLength(substr) <= targetBytes) {
      result = substr;
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return result + suffix;
}

async function flushApiRequestBuffer() {
  if (apiRequestBuffer.length === 0) {
    return;
  }

  const now = Date.now();
  const requests = [...apiRequestBuffer];
  apiRequestBuffer = [];

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const values: any[] = [];
    const placeholders: string[] = [];

    // 限制每个字段最大 5000 字节
    const MAX_COLUMN_BYTES = 5000;

    for (const request of requests) {
      let requestBody = request.request_body;
      let responseBody = request.response_body;

      // 最终安全检查：确保不会超过数据库列的最大字节长度
      if (requestBody && getByteLength(requestBody) > MAX_COLUMN_BYTES) {
        requestBody = truncateToByteLength(requestBody, MAX_COLUMN_BYTES);
      }
      if (responseBody && getByteLength(responseBody) > MAX_COLUMN_BYTES) {
        responseBody = truncateToByteLength(responseBody, MAX_COLUMN_BYTES);
      }

      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        request.id,
        request.virtual_key_id || null,
        request.provider_id || null,
        request.model || null,
        request.prompt_tokens || 0,
        request.completion_tokens || 0,
        request.total_tokens || 0,
        request.cached_tokens || 0,
        request.status,
        request.response_time || null,
        request.error_message || null,
        requestBody,
        responseBody,
        request.cache_hit || 0,
        request.request_type || 'chat',
        request.compression_original_tokens || null,
        request.compression_saved_tokens || null,
        now
      );
    }

    if (placeholders.length > 0) {
      await conn.query(
        `INSERT INTO api_requests (
          id, virtual_key_id, provider_id, model,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens,
          status, response_time, error_message, request_body, response_body, cache_hit,
          request_type, compression_original_tokens, compression_saved_tokens, created_at
        ) VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    await conn.commit();
  } catch (error: any) {
    await conn.rollback();
    console.error('[数据库] 批量写入 API 请求日志失败:', error.message);
    // 失败时放回缓冲区
    apiRequestBuffer.unshift(...requests);
  } finally {
    conn.release();
  }
}

export function flushApiRequestBufferNow() {
  return flushApiRequestBuffer();
}

export async function shutdownDatabase() {
  if (bufferFlushTimer) {
    clearInterval(bufferFlushTimer);
    bufferFlushTimer = null;
  }

  await flushApiRequestBuffer();

  if (pool) {
    await pool.end();
  }
}

async function createTables() {
  const conn = await pool.getConnection();
  
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        base_url TEXT NOT NULL,
        protocol_mappings TEXT,
        api_key TEXT NOT NULL,
        model_mapping TEXT,
        enabled TINYINT DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS models (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        provider_id VARCHAR(255),
        model_identifier VARCHAR(255) NOT NULL,
        protocol VARCHAR(50),
        is_virtual TINYINT DEFAULT 0,
        routing_config_id VARCHAR(255),
        expert_routing_id VARCHAR(255),
        enabled TINYINT DEFAULT 1,
        model_attributes TEXT,
        prompt_config TEXT,
        compression_config TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
        INDEX idx_models_provider (provider_id),
        INDEX idx_models_enabled (enabled),
        INDEX idx_models_is_virtual (is_virtual),
        INDEX idx_models_routing_config (routing_config_id),
        INDEX idx_models_prompt_config (prompt_config(255)),
        INDEX idx_models_compression_config (compression_config(255)),
        INDEX idx_models_expert_routing (expert_routing_id),
        INDEX idx_models_protocol (protocol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS virtual_keys (
        id VARCHAR(255) PRIMARY KEY,
        key_value VARCHAR(255) NOT NULL UNIQUE,
        key_hash VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        provider_id VARCHAR(255),
        model_id VARCHAR(255),
        routing_strategy VARCHAR(50) DEFAULT 'single',
        model_ids TEXT,
        routing_config TEXT,
        enabled TINYINT DEFAULT 1,
        rate_limit INT,
        cache_enabled TINYINT DEFAULT 0,
        disable_logging TINYINT DEFAULT 0,
        dynamic_compression_enabled TINYINT DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL,
        FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL,
        INDEX idx_virtual_keys_hash (key_hash),
        INDEX idx_virtual_keys_value (key_value),
        INDEX idx_virtual_keys_provider (provider_id),
        INDEX idx_virtual_keys_model (model_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        \`key\` VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS api_requests (
        id VARCHAR(255) PRIMARY KEY,
        virtual_key_id VARCHAR(255),
        provider_id VARCHAR(255),
        model VARCHAR(255),
        prompt_tokens INT DEFAULT 0,
        completion_tokens INT DEFAULT 0,
        total_tokens INT DEFAULT 0,
        status VARCHAR(50),
        response_time INT,
        error_message TEXT,
        request_body MEDIUMTEXT,
        response_body MEDIUMTEXT,
        cache_hit TINYINT DEFAULT 0,
        request_type VARCHAR(50) DEFAULT 'chat',
        compression_original_tokens INT DEFAULT NULL,
        compression_saved_tokens INT DEFAULT NULL,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE SET NULL,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL,
        INDEX idx_api_requests_created_at (created_at),
        INDEX idx_api_requests_virtual_key (virtual_key_id),
        INDEX idx_api_requests_provider (provider_id),
        INDEX idx_api_requests_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS routing_configs (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        type VARCHAR(50) NOT NULL,
        config TEXT NOT NULL,
        enabled TINYINT DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_type (type),
        INDEX idx_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS expert_routing_configs (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        enabled TINYINT DEFAULT 1,
        config TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_expert_routing_configs_enabled (enabled),
        INDEX idx_expert_routing_configs_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS expert_routing_logs (
        id VARCHAR(255) PRIMARY KEY,
        virtual_key_id VARCHAR(255),
        expert_routing_id VARCHAR(255) NOT NULL,
        request_hash VARCHAR(255) NOT NULL,
        classifier_model VARCHAR(255) NOT NULL,
        classification_result VARCHAR(255) NOT NULL,
        selected_expert_id VARCHAR(255) NOT NULL,
        selected_expert_type VARCHAR(50) NOT NULL,
        selected_expert_name VARCHAR(255) NOT NULL,
        classification_time INT,
        created_at BIGINT NOT NULL,
        original_request MEDIUMTEXT,
        classifier_request MEDIUMTEXT,
        classifier_response MEDIUMTEXT,
        FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE SET NULL,
        INDEX idx_expert_routing_logs_config (expert_routing_id),
        INDEX idx_expert_routing_logs_created_at (created_at),
        INDEX idx_expert_routing_logs_category (classification_result)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } finally {
    conn.release();
  }
}

export function getDatabase() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}

export const userDb = {
  async create(user: Omit<User, 'created_at' | 'updated_at'>): Promise<User> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [user.id, user.username, user.password_hash, now, now]
      );
      return { ...user, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async findByUsername(username: string): Promise<User | undefined> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users WHERE username = ?', [username]);
      const users = rows as any[];
      if (users.length === 0) return undefined;
      return users[0];
    } finally {
      conn.release();
    }
  },

  async findById(id: string): Promise<User | undefined> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users WHERE id = ?', [id]);
      const users = rows as any[];
      if (users.length === 0) return undefined;
      return users[0];
    } finally {
      conn.release();
    }
  },

  async getAll(): Promise<User[]> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users ORDER BY created_at DESC');
      return rows as User[];
    } finally {
      conn.release();
    }
  },
};

export const providerDb = {
  async getAll(): Promise<Provider[]> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM providers ORDER BY created_at DESC');
      return rows as Provider[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<Provider | undefined> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM providers WHERE id = ?', [id]);
      const providers = rows as any[];
      if (providers.length === 0) return undefined;
      return providers[0];
    } finally {
      conn.release();
    }
  },

  async create(provider: Omit<Provider, 'created_at' | 'updated_at'>): Promise<Provider> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO providers (id, name, description, base_url, protocol_mappings, api_key, model_mapping, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [provider.id, provider.name, provider.description || null, provider.base_url, provider.protocol_mappings || null, provider.api_key, provider.model_mapping || null, provider.enabled, now, now]
      );
      return { ...provider, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, updates: Partial<Omit<Provider, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.description !== undefined) {
        fields.push('description = ?');
        values.push(updates.description);
      }
      if (updates.base_url !== undefined) {
        fields.push('base_url = ?');
        values.push(updates.base_url);
      }
      if (updates.protocol_mappings !== undefined) {
        fields.push('protocol_mappings = ?');
        values.push(updates.protocol_mappings);
      }
      if (updates.api_key !== undefined) {
        fields.push('api_key = ?');
        values.push(updates.api_key);
      }
      if (updates.model_mapping !== undefined) {
        fields.push('model_mapping = ?');
        values.push(updates.model_mapping);
      }
      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled);
      }

      if (fields.length === 0) return;

      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);

      await conn.query(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM providers WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },
};

export const modelDb = {
  async getAll(): Promise<Model[]> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM models ORDER BY created_at DESC');
      return rows as Model[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<Model | undefined> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM models WHERE id = ?', [id]);
      const models = rows as any[];
      if (models.length === 0) return undefined;
      return models[0];
    } finally {
      conn.release();
    }
  },

  async getByProviderId(providerId: string): Promise<Model[]> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM models WHERE provider_id = ? ORDER BY created_at DESC', [providerId]);
      return rows as Model[];
    } finally {
      conn.release();
    }
  },

  async create(model: Omit<Model, 'created_at' | 'updated_at'>): Promise<Model> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO models (id, name, provider_id, model_identifier, protocol, is_virtual, routing_config_id, expert_routing_id, enabled, model_attributes, prompt_config, compression_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [model.id, model.name, model.provider_id, model.model_identifier, model.protocol || null, model.is_virtual, model.routing_config_id, model.expert_routing_id || null, model.enabled, model.model_attributes, model.prompt_config, model.compression_config, now, now]
      );
      return { ...model, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, updates: Partial<Omit<Model, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
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

      await conn.query(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM models WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },

  async countByProviderId(providerId: string): Promise<number> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT COUNT(*) as count FROM models WHERE provider_id = ?', [providerId]);
      const result = rows as any[];
      return result[0].count;
    } finally {
      conn.release();
    }
  },
};

export const virtualKeyDb = {
  async getAll(): Promise<VirtualKey[]> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM virtual_keys ORDER BY created_at DESC');
      return rows as VirtualKey[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<VirtualKey | undefined> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM virtual_keys WHERE id = ?', [id]);
      const keys = rows as any[];
      if (keys.length === 0) return undefined;
      return keys[0];
    } finally {
      conn.release();
    }
  },

  async getByKeyValue(keyValue: string): Promise<VirtualKey | undefined> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM virtual_keys WHERE key_value = ?', [keyValue]);
      const keys = rows as any[];
      if (keys.length === 0) return undefined;
      return keys[0];
    } finally {
      conn.release();
    }
  },

  async create(vk: Omit<VirtualKey, 'created_at' | 'updated_at'>): Promise<VirtualKey> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO virtual_keys (
          id, key_value, key_hash, name, provider_id, model_id,
          routing_strategy, model_ids, routing_config,
          enabled, rate_limit, cache_enabled, disable_logging, dynamic_compression_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          vk.disable_logging || 0,
          vk.dynamic_compression_enabled || 0,
          now,
          now
        ]
      );
      return { ...vk, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, updates: Partial<Omit<VirtualKey, 'id' | 'key_value' | 'key_hash' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
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

      await conn.query(`UPDATE virtual_keys SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM virtual_keys WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },

  async countByModelId(modelId: string): Promise<number> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT COUNT(*) as count FROM virtual_keys WHERE model_id = ?', [modelId]);
      const result = rows as any[];
      return result[0].count;
    } finally {
      conn.release();
    }
  },

  async countByModelIds(modelIds: string[]): Promise<Map<string, number>> {
    if (modelIds.length === 0) return new Map();

    const conn = await pool.getConnection();
    try {
      const placeholders = modelIds.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT model_id, COUNT(*) as count FROM virtual_keys WHERE model_id IN (${placeholders}) GROUP BY model_id`,
        modelIds
      );
      const result = rows as any[];
      const map = new Map<string, number>();
      result.forEach(row => {
        map.set(row.model_id, row.count);
      });
      return map;
    } finally {
      conn.release();
    }
  },
};

export const systemConfigDb = {
  async get(key: string): Promise<SystemConfig | undefined> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM system_config WHERE `key` = ?', [key]);
      const configs = rows as any[];
      if (configs.length === 0) return undefined;
      return configs[0];
    } finally {
      conn.release();
    }
  },

  async set(key: string, value: string, description?: string): Promise<void> {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      const existing = await this.get(key);

      if (existing) {
        await conn.query(
          'UPDATE system_config SET value = ?, description = ?, updated_at = ? WHERE `key` = ?',
          [value, description || null, now, key]
        );
      } else {
        await conn.query(
          'INSERT INTO system_config (`key`, value, description, updated_at) VALUES (?, ?, ?, ?)',
          [key, value, description || null, now]
        );
      }
    } finally {
      conn.release();
    }
  },
};

export const apiRequestDb = {
  async create(request: ApiRequestBuffer): Promise<void> {
    apiRequestBuffer.push(request);

    if (apiRequestBuffer.length >= BUFFER_MAX_SIZE) {
      await flushApiRequestBuffer();
    }
  },

  async getStats(options?: { startTime?: number; endTime?: number }) {
    const now = Date.now();
    const startTime = options?.startTime || now - 24 * 60 * 60 * 1000;
    const endTime = options?.endTime || now;

    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT
          COUNT(*) as total_requests,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) as successful_requests,
          SUM(CASE WHEN ar.status = 'error' THEN 1 ELSE 0 END) as failed_requests,
          SUM(CASE WHEN ar.cache_hit = 0 THEN ar.total_tokens ELSE 0 END) as total_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN ar.prompt_tokens ELSE 0 END) as prompt_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN ar.completion_tokens ELSE 0 END) as completion_tokens,
          SUM(ar.cached_tokens) as cached_tokens,
          AVG(ar.response_time) as avg_response_time,
          SUM(CASE WHEN ar.cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits,
          SUM(CASE WHEN ar.cached_tokens > 0 THEN 1 ELSE 0 END) as prompt_cache_hits,
          0 as cache_saved_tokens
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ${loggingCondition}`,
        [startTime, endTime]
      );

      const result = rows as any[];
      if (result.length === 0) {
        return {
          totalRequests: 0,
          successfulRequests: 0,
          failedRequests: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          avgResponseTime: 0,
          cacheHits: 0,
          promptCacheHits: 0,
          cacheSavedTokens: 0,
        };
      }

      const row = result[0];
      return {
        totalRequests: row.total_requests || 0,
        successfulRequests: row.successful_requests || 0,
        failedRequests: row.failed_requests || 0,
        totalTokens: row.total_tokens || 0,
        promptTokens: row.prompt_tokens || 0,
        completionTokens: row.completion_tokens || 0,
        cachedTokens: row.cached_tokens || 0,
        avgResponseTime: row.avg_response_time || 0,
        cacheHits: row.cache_hits || 0,
        promptCacheHits: row.prompt_cache_hits || 0,
        cacheSavedTokens: row.cache_saved_tokens || 0,
      };
    } finally {
      conn.release();
    }
  },

  async getByVirtualKey(virtualKeyId: string, limit: number = 100) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ar.*
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.virtual_key_id = ? AND ${getDisableLoggingCondition()}
         ORDER BY ar.created_at DESC
         LIMIT ?`,
        [virtualKeyId, limit]
      );
      return rows;
    } finally {
      conn.release();
    }
  },

  async getTrend(options?: { startTime?: number; endTime?: number; interval?: 'hour' | 'day' }) {
    const now = Date.now();
    const startTime = options?.startTime || now - 24 * 60 * 60 * 1000;
    const endTime = options?.endTime || now;
    const interval = options?.interval || 'hour';

    const intervalMs = interval === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT
          FLOOR(ar.created_at / ?) * ? as time_bucket,
          ar.virtual_key_id,
          vk.name as virtual_key_name,
          COUNT(*) as count,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN ar.status = 'error' THEN 1 ELSE 0 END) as error_count,
          SUM(ar.total_tokens) as total_tokens
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ${loggingCondition}
        GROUP BY time_bucket, ar.virtual_key_id, vk.name
        HAVING time_bucket IS NOT NULL
        ORDER BY time_bucket ASC, ar.virtual_key_id ASC`,
        [intervalMs, intervalMs, startTime, endTime]
      );

      const result = rows as any[];

      if (!result || result.length === 0) {
        return [];
      }

      const virtualKeyMap = new Map<string, { id: string; name: string }>();
      const dataByKey = new Map<string, Map<number, any>>();

      const timePoints = generateTimeBuckets(startTime, endTime, intervalMs);

      result.forEach(row => {
        const keyId = row.virtual_key_id || 'unknown';
        const keyName = row.virtual_key_name || '未知密钥';

        if (!virtualKeyMap.has(keyId)) {
          virtualKeyMap.set(keyId, { id: keyId, name: keyName });
        }

        if (!dataByKey.has(keyId)) {
          dataByKey.set(keyId, initializeTimeBuckets(timePoints));
        }

        const bucket = Number(row.time_bucket);
        if (!bucket || isNaN(bucket)) {
          return;
        }

        const keyBuckets = dataByKey.get(keyId)!;
        if (keyBuckets.has(bucket)) {
          keyBuckets.set(bucket, {
            timestamp: bucket,
            requestCount: Number(row.count) || 0,
            successCount: Number(row.success_count) || 0,
            errorCount: Number(row.error_count) || 0,
            tokenCount: Number(row.total_tokens) || 0
          });
        }
      });

      const trendByKey = Array.from(dataByKey.entries()).map(([keyId, buckets]) => ({
        virtualKeyId: keyId,
        virtualKeyName: virtualKeyMap.get(keyId)?.name || '未知密钥',
        data: Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp)
      }));

      return trendByKey;
    } finally {
      conn.release();
    }
  },

  async getAll(options?: {
    limit?: number;
    offset?: number;
    virtualKeyId?: string;
    startTime?: number;
    endTime?: number;
    status?: string;
  }) {
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;

    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      let countQuery = `
        SELECT COUNT(*) as total
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ${loggingCondition}
      `;
      let dataQuery = `
        SELECT ar.*
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ${loggingCondition}
      `;
      const params: any[] = [];

      if (options?.virtualKeyId) {
        countQuery += ' AND ar.virtual_key_id = ?';
        dataQuery += ' AND ar.virtual_key_id = ?';
        params.push(options.virtualKeyId);
      }

      if (options?.startTime) {
        countQuery += ' AND ar.created_at >= ?';
        dataQuery += ' AND ar.created_at >= ?';
        params.push(options.startTime);
      }

      if (options?.endTime) {
        countQuery += ' AND ar.created_at <= ?';
        dataQuery += ' AND ar.created_at <= ?';
        params.push(options.endTime);
      }

      if (options?.status) {
        countQuery += ' AND ar.status = ?';
        dataQuery += ' AND ar.status = ?';
        params.push(options.status);
      }

      const [countRows] = await conn.query(countQuery, params);
      const total = (countRows as any[])[0].total;

      dataQuery += ' ORDER BY ar.created_at DESC LIMIT ? OFFSET ?';
      const dataParams = [...params, limit, offset];

      const [rows] = await conn.query(dataQuery, dataParams);

      return {
        data: rows,
        total,
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      };
    } finally {
      conn.release();
    }
  },

  async getById(id: string) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ar.*
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.id = ? AND ${getDisableLoggingCondition()}`,
        [id]
      );
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async cleanOldRecords(daysToKeep: number = 30): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        'UPDATE api_requests SET request_body = NULL, response_body = NULL WHERE created_at < ? AND (request_body IS NOT NULL OR response_body IS NOT NULL)',
        [cutoffTime]
      );
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },

  async getModelStats(options: { startTime: number; endTime: number }) {
    const { startTime, endTime } = options;
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT
          ar.model,
          p.name as provider_name,
          COUNT(*) as request_count,
          SUM(ar.total_tokens) as total_tokens,
          AVG(ar.response_time) as avg_response_time
        FROM api_requests ar
        LEFT JOIN providers p ON ar.provider_id = p.id
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ar.model IS NOT NULL AND ${loggingCondition}
        GROUP BY ar.model, p.name
        ORDER BY request_count DESC
        LIMIT 5`,
        [startTime, endTime]
      );
      return rows as any[];
    } finally {
      conn.release();
    }
  },
};

export const routingConfigDb = {
  async getAll() {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM routing_configs ORDER BY created_at DESC');
      return rows;
    } finally {
      conn.release();
    }
  },

  async getById(id: string) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM routing_configs WHERE id = ?', [id]);
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async create(data: {
    id: string;
    name: string;
    description?: string;
    type: string;
    config: string;
    enabled: number;
  }) {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO routing_configs (id, name, description, type, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [data.id, data.name, data.description || null, data.type, data.config, data.enabled, now, now]
      );
      return { ...data, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, data: {
    name?: string;
    description?: string;
    type?: string;
    config?: string;
    enabled?: number;
  }) {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];

      Object.entries(data).forEach(([key, value]) => {
        fields.push(`${key} = ?`);
        values.push(value);
      });

      if (fields.length === 0) return;

      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);

      await conn.query(`UPDATE routing_configs SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string) {
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM routing_configs WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },
};

export const expertRoutingConfigDb = {
  async getAll() {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM expert_routing_configs ORDER BY created_at DESC');
      return rows;
    } finally {
      conn.release();
    }
  },

  async getById(id: string) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM expert_routing_configs WHERE id = ?', [id]);
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async getEnabled() {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM expert_routing_configs WHERE enabled = 1 ORDER BY created_at DESC');
      return rows;
    } finally {
      conn.release();
    }
  },

  async create(data: {
    id: string;
    name: string;
    description?: string;
    enabled: number;
    config: string;
  }) {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO expert_routing_configs (id, name, description, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [data.id, data.name, data.description || null, data.enabled, data.config, now, now]
      );
      return { ...data, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, data: {
    name?: string;
    description?: string;
    enabled?: number;
    config?: string;
  }) {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];

      Object.entries(data).forEach(([key, value]) => {
        fields.push(`${key} = ?`);
        values.push(value);
      });

      if (fields.length === 0) return;

      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);

      await conn.query(`UPDATE expert_routing_configs SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string) {
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM expert_routing_configs WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },
};

export const expertRoutingLogDb = {
  async create(log: {
    id: string;
    virtual_key_id: string | null;
    expert_routing_id: string;
    request_hash: string;
    classifier_model: string;
    classification_result: string;
    selected_expert_id: string;
    selected_expert_type: string;
    selected_expert_name: string;
    classification_time: number;
    original_request?: string;
    classifier_request?: string;
    classifier_response?: string;
  }) {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO expert_routing_logs (
          id, virtual_key_id, expert_routing_id, request_hash,
          classifier_model, classification_result, selected_expert_id,
          selected_expert_type, selected_expert_name, classification_time,
          original_request, classifier_request, classifier_response, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.id,
          log.virtual_key_id || null,
          log.expert_routing_id,
          log.request_hash,
          log.classifier_model,
          log.classification_result,
          log.selected_expert_id,
          log.selected_expert_type,
          log.selected_expert_name,
          log.classification_time,
          log.original_request || null,
          log.classifier_request || null,
          log.classifier_response || null,
          now,
        ]
      );
    } finally {
      conn.release();
    }
  },

  async getByConfigId(configId: string, limit: number = 100) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT * FROM expert_routing_logs WHERE expert_routing_id = ? ORDER BY created_at DESC LIMIT ?',
        [configId, limit]
      );
      return rows;
    } finally {
      conn.release();
    }
  },

  async getStatistics(configId: string, timeRange?: number) {
    const conn = await pool.getConnection();
    try {
      let query = `
        SELECT
          classification_result,
          COUNT(*) as count,
          AVG(classification_time) as avg_time
        FROM expert_routing_logs
        WHERE expert_routing_id = ?
      `;
      const params: any[] = [configId];

      if (timeRange) {
        const cutoffTime = Date.now() - timeRange;
        query += ' AND created_at >= ?';
        params.push(cutoffTime);
      }

      query += ' GROUP BY classification_result';

      const [rows] = await conn.query(query, params);
      return rows;
    } finally {
      conn.release();
    }
  },

  async getByCategory(configId: string, category: string, limit: number = 100) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT * FROM expert_routing_logs WHERE expert_routing_id = ? AND classification_result = ? ORDER BY created_at DESC LIMIT ?',
        [configId, category, limit]
      );
      return rows;
    } finally {
      conn.release();
    }
  },

  async getById(id: string) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM expert_routing_logs WHERE id = ?', [id]);
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async getGlobalStatistics(startTime: number) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
          COUNT(*) as total_requests,
          AVG(classification_time) as avg_classification_time
        FROM expert_routing_logs
        WHERE created_at >= ?`,
        [startTime]
      );
      const result = rows as any[];
      if (result.length === 0) {
        return {
          totalRequests: 0,
          avgClassificationTime: 0,
        };
      }
      return {
        totalRequests: result[0].total_requests || 0,
        avgClassificationTime: Math.round(result[0].avg_classification_time || 0),
      };
    } finally {
      conn.release();
    }
  },
};

export function getPool() {
  return pool;
}
