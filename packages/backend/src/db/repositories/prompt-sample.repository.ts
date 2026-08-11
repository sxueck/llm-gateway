import { getDatabase } from '../connection.js';

export interface PromptSampleRecord {
  id: string;
  virtual_key_id: string;
  model: string;
  protocol: string;
  intent_text: string;
  prompt_tokens: number;
  intent_truncated: number;
  created_at: number;
}

export interface PromptSampleQuery {
  virtualKeyId?: string;
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
}

function buildWhereClause(query: PromptSampleQuery): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (query.virtualKeyId) {
    conditions.push('virtual_key_id = ?');
    values.push(query.virtualKeyId);
  }
  if (query.startTime !== undefined) {
    conditions.push('created_at >= ?');
    values.push(query.startTime);
  }
  if (query.endTime !== undefined) {
    conditions.push('created_at <= ?');
    values.push(query.endTime);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

export const promptSampleRepository = {
  async create(sample: PromptSampleRecord): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO prompt_samples (
          id, virtual_key_id, model, protocol, intent_text,
          prompt_tokens, intent_truncated, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sample.id, sample.virtual_key_id, sample.model, sample.protocol,
          sample.intent_text, sample.prompt_tokens, sample.intent_truncated, sample.created_at,
        ]
      );
    } finally {
      conn.release();
    }
  },

  async getAll(query: PromptSampleQuery = {}): Promise<{ data: PromptSampleRecord[]; total: number }> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    const { where, values } = buildWhereClause(query);
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize || 20));
    try {
      const [rows] = await conn.query(
        `SELECT * FROM prompt_samples ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...values, pageSize, (page - 1) * pageSize]
      );
      const [countRows] = await conn.query(
        `SELECT COUNT(*) AS total FROM prompt_samples ${where}`,
        values
      );
      return { data: rows as PromptSampleRecord[], total: Number((countRows as any[])[0]?.total || 0) };
    } finally {
      conn.release();
    }
  },

  async getForExport(query: PromptSampleQuery = {}): Promise<PromptSampleRecord[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    const { where, values } = buildWhereClause(query);
    try {
      const [rows] = await conn.query(
        `SELECT * FROM prompt_samples ${where} ORDER BY created_at DESC LIMIT 10000`,
        values
      );
      return rows as PromptSampleRecord[];
    } finally {
      conn.release();
    }
  },

  async deleteById(id: string): Promise<boolean> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query('DELETE FROM prompt_samples WHERE id = ?', [id]);
      return (result as any).affectedRows > 0;
    } finally {
      conn.release();
    }
  },

  async cleanOldRecords(daysToKeep: number): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query('DELETE FROM prompt_samples WHERE created_at < ?', [cutoffTime]);
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },
};
