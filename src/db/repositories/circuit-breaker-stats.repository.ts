import { getDatabase } from '../connection.js';

export interface CircuitBreakerStatsRow {
  provider_id: string;
  trigger_count: number;
  last_trigger_at: number;
  created_at: number;
  updated_at: number;
}

class CircuitBreakerStatsRepository {
  async incrementTrigger(providerId: string): Promise<void> {
    const pool = getDatabase();
    const now = Date.now();

    // Insert-or-update trigger_count for provider (累计统计)
    await pool.query(
      `INSERT INTO circuit_breaker_stats (provider_id, trigger_count, last_trigger_at, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         trigger_count = trigger_count + 1,
         last_trigger_at = VALUES(last_trigger_at),
         updated_at = VALUES(updated_at)`,
      [providerId, now, now, now]
    );

    await pool.query(
      `INSERT INTO circuit_breaker_events (provider_id, triggered_at) VALUES (?, ?)`,
      [providerId, now]
    );
  }

  async getGlobalStats(startTime?: number): Promise<{
    totalTriggers: number;
    maxTriggeredProvider: string;
    maxTriggerCount: number;
  }> {
    const pool = getDatabase();

    let query: string;
    let params: any[] = [];

    if (startTime !== undefined) {
      // 从事件表按时间范围统计
      query = `
        SELECT provider_id, COUNT(*) as trigger_count
        FROM circuit_breaker_events
        WHERE triggered_at >= ?
        GROUP BY provider_id
      `;
      params = [startTime];
    } else {
      // 不限时间，从累计统计表读取
      query = `SELECT provider_id, trigger_count FROM circuit_breaker_stats`;
    }

    const [rows] = await pool.query<any[]>(query, params);

    const stats = rows as Array<{ provider_id: string; trigger_count: number }>;
    if (!stats || stats.length === 0) {
      return {
        totalTriggers: 0,
        maxTriggeredProvider: '-',
        maxTriggerCount: 0,
      };
    }

    let totalTriggers = 0;
    let maxTriggeredProvider = '-';
    let maxTriggerCount = 0;

    for (const row of stats) {
      const count = Number(row.trigger_count || 0);
      totalTriggers += count;
      if (count > maxTriggerCount) {
        maxTriggerCount = count;
        maxTriggeredProvider = row.provider_id;
      }
    }

    return {
      totalTriggers,
      maxTriggeredProvider,
      maxTriggerCount,
    };
  }
}

export const circuitBreakerStatsRepository = new CircuitBreakerStatsRepository();
