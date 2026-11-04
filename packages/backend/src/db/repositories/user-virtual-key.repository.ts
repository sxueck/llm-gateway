import { getDatabase } from '../connection.js';
import type { ResultSetHeader } from 'mysql2/promise';
import { VirtualKey } from '../../types/index.js';

export interface UserVirtualKeyBinding {
  user_id: string;
  virtual_key_id: string;
  created_at: number;
}

/** 管理端列表行：绑定时间 + 两侧可读名称。 */
export interface UserVirtualKeyBindingView extends UserVirtualKeyBinding {
  username: string | null;
  virtual_key_name: string | null;
}

export interface BindResult {
  /** 本次真正新写入的 virtual_key_id。 */
  bound: string[];
  /** 请求里已处于绑定状态的 virtual_key_id（幂等重放不报错）。 */
  alreadyBound: string[];
}

function inPlaceholders(ids: string[]): string {
  return ids.map(() => '?').join(', ');
}

export const userVirtualKeyRepository = {
  /**
   * 普通用户授权的取数入口：每个请求实时读取，无缓存——解绑/删钥在
   * 下一个请求立即生效（撤销即时性依赖这一点，请勿在此之上加缓存）。
   */
  async listVirtualKeyIdsByUser(userId: string): Promise<string[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT virtual_key_id FROM user_virtual_keys WHERE user_id = ?',
        [userId],
      );
      return (rows as Array<{ virtual_key_id: string }>).map(
        (row) => row.virtual_key_id,
      );
    } finally {
      conn.release();
    }
  },

  /** INNER JOIN：密钥行随 FK CASCADE 删除后绑定行同亡，不会返回半行。 */
  async getVirtualKeysByUserId(
    userId: string,
  ): Promise<Array<VirtualKey & { bound_at: number }>> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT vk.*, uvk.created_at AS bound_at
         FROM user_virtual_keys uvk
         INNER JOIN virtual_keys vk ON vk.id = uvk.virtual_key_id
         WHERE uvk.user_id = ?
         ORDER BY vk.created_at DESC`,
        [userId],
      );
      return rows as Array<VirtualKey & { bound_at: number }>;
    } finally {
      conn.release();
    }
  },

  async listBoundUsersByVirtualKey(
    virtualKeyId: string,
  ): Promise<Array<{ user_id: string; username: string; bound_at: number }>> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT uvk.user_id, u.username, uvk.created_at AS bound_at
         FROM user_virtual_keys uvk
         INNER JOIN users u ON u.id = uvk.user_id
         WHERE uvk.virtual_key_id = ?
         ORDER BY uvk.created_at ASC`,
        [virtualKeyId],
      );
      return rows as Array<{
        user_id: string;
        username: string;
        bound_at: number;
      }>;
    } finally {
      conn.release();
    }
  },

  /** 管理端全量绑定视图；users 无 FK，两侧都 LEFT JOIN 防御半删状态。 */
  async getAllBindings(): Promise<UserVirtualKeyBindingView[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT uvk.user_id, u.username, uvk.virtual_key_id,
                vk.name AS virtual_key_name, uvk.created_at
         FROM user_virtual_keys uvk
         LEFT JOIN users u ON u.id = uvk.user_id
         LEFT JOIN virtual_keys vk ON vk.id = uvk.virtual_key_id
         ORDER BY uvk.created_at DESC`,
      );
      return rows as UserVirtualKeyBindingView[];
    } finally {
      conn.release();
    }
  },

  async getBoundVirtualKeyIds(
    userId: string,
    virtualKeyIds: string[],
  ): Promise<string[]> {
    if (virtualKeyIds.length === 0) return [];
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT virtual_key_id FROM user_virtual_keys
         WHERE user_id = ? AND virtual_key_id IN (${inPlaceholders(virtualKeyIds)})`,
        [userId, ...virtualKeyIds],
      );
      return (rows as Array<{ virtual_key_id: string }>).map(
        (row) => row.virtual_key_id,
      );
    } finally {
      conn.release();
    }
  },

  /**
   * 幂等绑定：唯一键冲突时不修改现有绑定；其他数据库错误必须传播。
   */
  async bind(userId: string, virtualKeyIds: string[]): Promise<BindResult> {
    const uniqueIds = [...new Set(virtualKeyIds)];
    if (uniqueIds.length === 0) return { bound: [], alreadyBound: [] };

    const existing = await this.getBoundVirtualKeyIds(userId, uniqueIds);
    const already = new Set(existing);
    const missing = uniqueIds.filter((id) => !already.has(id));

    if (missing.length > 0) {
      const pool = getDatabase();
      const conn = await pool.getConnection();
      try {
        await conn.query(
          `INSERT INTO user_virtual_keys (user_id, virtual_key_id) VALUES ${missing
            .map(() => '(?, ?)')
            .join(', ')} ON DUPLICATE KEY UPDATE user_id = user_id`,
          missing.flatMap((id) => [userId, id]),
        );
      } finally {
        conn.release();
      }
    }

    return { bound: missing, alreadyBound: existing };
  },

  /** 解除单个绑定；返回 false 表示绑定本来就不存在（供路由层转 404）。 */
  async unbind(userId: string, virtualKeyId: string): Promise<boolean> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        'DELETE FROM user_virtual_keys WHERE user_id = ? AND virtual_key_id = ?',
        [userId, virtualKeyId],
      );
      return ((result as ResultSetHeader).affectedRows ?? 0) > 0;
    } finally {
      conn.release();
    }
  },

  /** 解除某用户的全部绑定；返回被删除的行数（撤销立即生效的批量形态）。 */
  async unbindAllByUser(userId: string): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        'DELETE FROM user_virtual_keys WHERE user_id = ?',
        [userId],
      );
      return (result as ResultSetHeader).affectedRows ?? 0;
    } finally {
      conn.release();
    }
  },

  async isBound(userId: string, virtualKeyId: string): Promise<boolean> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT 1 AS bound FROM user_virtual_keys WHERE user_id = ? AND virtual_key_id = ? LIMIT 1',
        [userId, virtualKeyId],
      );
      return (rows as unknown[]).length > 0;
    } finally {
      conn.release();
    }
  },
};
