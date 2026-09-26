import { getDatabase } from '../connection.js';
import { VirtualKey } from '../../types/index.js';

/**
 * Model info needed for reference counting from routing_config.
 * Models are matched by provider_id + (model_identifier || name).
 */
export interface ModelReferenceInfo {
  id: string;
  provider_id: string | null;
  model_identifier: string;
  name: string;
}

/**
 * Routing target structure within routing_config.
 * Mirrors RoutingTarget from routes/proxy/routing.ts
 */
interface RoutingTarget {
  provider?: string;
  override_params?: {
    model?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

function routingTargetKey(providerId: string, modelName: string): string {
  return `${providerId}\u0000${modelName}`;
}

interface VirtualKeyReferences {
  modelIds: Set<string>;
  routingTargets: Set<string>;
}

function parseVirtualKeyReferences(virtualKey: {
  model_id: string | null;
  model_ids: string | null;
  routing_config: string | null;
}): VirtualKeyReferences {
  const modelIds = new Set<string>();
  const routingTargets = new Set<string>();

  if (virtualKey.model_id) modelIds.add(virtualKey.model_id);

  if (virtualKey.model_ids) {
    try {
      const parsed = JSON.parse(virtualKey.model_ids);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string') modelIds.add(id);
        }
      }
    } catch {
      // Malformed JSON - skip this path.
    }
  }

  if (virtualKey.routing_config) {
    try {
      const parsed = JSON.parse(virtualKey.routing_config);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.targets)) {
        for (const target of parsed.targets as RoutingTarget[]) {
          const provider = target.provider;
          const model = target.override_params?.model;
          if (typeof provider === 'string' && typeof model === 'string' && model) {
            routingTargets.add(routingTargetKey(provider, model));
          }
        }
      }
    } catch {
      // Malformed JSON - skip this path.
    }
  }

  return { modelIds, routingTargets };
}

/**
 * Count how many virtual keys reference each model.
 *
 * Counts references from:
 * - Direct bindings: virtual_keys.model_id
 * - Multi bindings: virtual_keys.model_ids JSON array
 * - Routing config: virtual_keys.routing_config.targets[].override_params.model
 *
 * Deduplication: One virtual key referencing the same model via multiple paths counts at most once.
 *
 * Malformed routing_config or model_ids are safely tolerated and skipped.
 */
async function countVirtualKeysByModels(
  models: ModelReferenceInfo[]
): Promise<Map<string, number>> {
  if (models.length === 0) return new Map();

  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    // Fetch all virtual keys with fields needed for reference counting
    // We need: id, model_id, model_ids, routing_config
    const [rows] = await conn.query(
      `SELECT id, model_id, model_ids, routing_config FROM virtual_keys`
    );
    const virtualKeys = rows as Array<{
      id: string;
      model_id: string | null;
      model_ids: string | null;
      routing_config: string | null;
    }>;

    const result = new Map<string, number>();

    // Initialize all model counts to 0
    for (const model of models) {
      result.set(model.id, 0);
    }

    const modelsByRoutingTarget = new Map<string, string[]>();
    for (const model of models) {
      if (!model.provider_id) continue;
      for (const modelName of [model.model_identifier, model.name]) {
        const key = routingTargetKey(model.provider_id, modelName);
        const modelIds = modelsByRoutingTarget.get(key);
        if (modelIds) modelIds.push(model.id);
        else modelsByRoutingTarget.set(key, [model.id]);
      }
    }

    // Parse each virtual key once and deduplicate references before incrementing.
    for (const virtualKey of virtualKeys) {
      const references = parseVirtualKeyReferences(virtualKey);
      const referencedModelIds = new Set<string>();

      for (const modelId of references.modelIds) {
        if (result.has(modelId)) referencedModelIds.add(modelId);
      }
      for (const targetKey of references.routingTargets) {
        for (const modelId of modelsByRoutingTarget.get(targetKey) || []) {
          referencedModelIds.add(modelId);
        }
      }

      for (const modelId of referencedModelIds) {
        result.set(modelId, result.get(modelId)! + 1);
      }
    }

    return result;
  } finally {
    conn.release();
  }
}

/**
 * Legacy function - kept for backward compatibility.
 * Use countVirtualKeysByModels() for new code.
 */
async function countVirtualKeysByModelIds(modelIds: string[]): Promise<Map<string, number>> {
  // For legacy compatibility, fetch minimal model info
  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    const placeholders = modelIds.map(() => '?').join(',');
    const [rows] = await conn.query(
      `SELECT id, provider_id, model_identifier, name FROM models WHERE id IN (${placeholders})`,
      modelIds
    );
    const models = (rows as any[]).map(row => ({
      id: row.id,
      provider_id: row.provider_id,
      model_identifier: row.model_identifier,
      name: row.name
    })) as ModelReferenceInfo[];

    return countVirtualKeysByModels(models);
  } finally {
    conn.release();
  }
}


export const virtualKeyRepository = {
  async getAll(): Promise<VirtualKey[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM virtual_keys ORDER BY created_at DESC');
      return rows as VirtualKey[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<VirtualKey | undefined> {
    const pool = getDatabase();
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
    const pool = getDatabase();
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
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO virtual_keys (
          id, key_value, key_hash, name, provider_id, model_id,
          routing_strategy, model_ids, routing_config,
           enabled, rate_limit, cache_enabled, disable_logging, dynamic_compression_enabled, image_compression_enabled, intercept_zero_temperature, zero_temperature_replacement, pii_protection_enabled, prompt_capture_enabled, context_normalization_enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          vk.image_compression_enabled || 0,
          vk.intercept_zero_temperature || 0,
          vk.zero_temperature_replacement,
          vk.pii_protection_enabled || 0,
          vk.prompt_capture_enabled || 0,
          vk.context_normalization_enabled || 0,
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
    const pool = getDatabase();
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

  // Dedicated credential write path: update() intentionally excludes key_value/key_hash.
  async rotate(id: string, keyValue: string, keyHash: string): Promise<VirtualKey | undefined> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query('UPDATE virtual_keys SET key_value = ?, key_hash = ?, updated_at = ? WHERE id = ?', [
        keyValue,
        keyHash,
        now,
        id,
      ]);
      return this.getById(id);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM virtual_keys WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },

  async countByModelId(modelId: string): Promise<number> {
    const map = await countVirtualKeysByModelIds([modelId]);
    return map.get(modelId) || 0;
  },

  async countByModelIds(modelIds: string[]): Promise<Map<string, number>> {
    return countVirtualKeysByModelIds(modelIds);
  },

  /**
   * Count virtual key references for multiple models with full model metadata.
   * This is the preferred method for accurate reference counting including
   * routing_config-based references.
   *
   * @param models Array of model info objects with id, provider_id, model_identifier, name
   * @returns Map from model id to reference count
   */
  async countByModels(models: ModelReferenceInfo[]): Promise<Map<string, number>> {
    return countVirtualKeysByModels(models);
  },
};
