import type { Connection } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { migrations } from './migrations.js';
import { ensureUserVirtualKeysTable, userVirtualKeysMigration } from './user-access-migration.js';

describe('user virtual key migration', () => {
  it('is registered and creates an indexed, cascading binding table', async () => {
    const conn = { query: vi.fn().mockResolvedValue([[]]) };
    expect(migrations).toContain(userVirtualKeysMigration);
    await ensureUserVirtualKeysTable(conn as unknown as Connection);
    const sql = conn.query.mock.calls[0][0] as string;
    expect(sql).toContain('PRIMARY KEY (user_id, virtual_key_id)');
    expect(sql).toContain('REFERENCES virtual_keys(id) ON DELETE CASCADE');
  });
  it('skips DDL on a scratch database and creates it when virtual_keys exists', async () => {
    const conn = { query: vi.fn().mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ name: 'virtual_keys' }]]).mockResolvedValue([[]]) };
    await userVirtualKeysMigration.up(conn as unknown as Connection);
    expect(conn.query).toHaveBeenCalledTimes(1);
    await userVirtualKeysMigration.up(conn as unknown as Connection);
    expect(conn.query).toHaveBeenCalledTimes(3);
  });
});
