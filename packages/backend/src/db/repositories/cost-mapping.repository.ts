import { getDatabase } from '../connection.js';
import { CostMapping } from '../types.js';

class CostMappingRepository {
  async create(mapping: CostMapping): Promise<void> {
    const pool = getDatabase();
    await pool.query(
      'INSERT INTO cost_mappings (id, pattern, target_model, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [mapping.id, mapping.pattern, mapping.target_model, mapping.priority, mapping.enabled, mapping.created_at, mapping.updated_at]
    );
  }

  async update(id: string, mapping: Partial<CostMapping>): Promise<void> {
    const pool = getDatabase();
    const updates: string[] = [];
    const values: any[] = [];

    if (mapping.pattern !== undefined) {
      updates.push('pattern = ?');
      values.push(mapping.pattern);
    }
    if (mapping.target_model !== undefined) {
      updates.push('target_model = ?');
      values.push(mapping.target_model);
    }
    if (mapping.priority !== undefined) {
      updates.push('priority = ?');
      values.push(mapping.priority);
    }
    if (mapping.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(mapping.enabled);
    }
    
    updates.push('updated_at = ?');
    values.push(Date.now());

    values.push(id);

    if (updates.length > 1) {
      await pool.query(
        `UPDATE cost_mappings SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }
  }

  async delete(id: string): Promise<void> {
    const pool = getDatabase();
    await pool.query('DELETE FROM cost_mappings WHERE id = ?', [id]);
  }

  async getById(id: string): Promise<CostMapping | null> {
    const pool = getDatabase();
    const [rows] = await pool.query<any[]>('SELECT * FROM cost_mappings WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    return rows[0] as CostMapping;
  }

  async getAll(): Promise<CostMapping[]> {
    const pool = getDatabase();
    const [rows] = await pool.query<any[]>('SELECT * FROM cost_mappings ORDER BY priority DESC, created_at DESC');
    return rows as CostMapping[];
  }

  async getEnabledMappings(): Promise<CostMapping[]> {
    const pool = getDatabase();
    const [rows] = await pool.query<any[]>('SELECT * FROM cost_mappings WHERE enabled = 1 ORDER BY priority DESC');
    return rows as CostMapping[];
  }
}

export const costMappingRepository = new CostMappingRepository();