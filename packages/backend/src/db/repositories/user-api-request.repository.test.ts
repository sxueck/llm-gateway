import { describe, expect, it, vi } from 'vitest';

const conn = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock('../connection.js', () => ({ getDatabase: () => ({ getConnection: async () => conn }) }));
import { userApiRequestRepository } from './user-api-request.repository.js';

describe('user request repository', () => {
  it('restricts list and detail SQL to bound key IDs and reads legacy payloads', async () => {
    conn.query.mockReset();
    conn.query.mockResolvedValueOnce([[{ total: 1 }]]).mockResolvedValueOnce([[{ id: 'r1' }]]).mockResolvedValueOnce([[{ id: 'r1', virtual_key_id: 'k1', payload_request_body: 'request', payload_response_body: 'response' }]]);
    await userApiRequestRepository.listForVirtualKeys({ virtualKeyIds: ['k1'], limit: 20, offset: 0 });
    const detail = await userApiRequestRepository.getByIdForVirtualKeys('r1', ['k1']);
    for (const call of conn.query.mock.calls) expect(call[0]).toContain('ar.virtual_key_id IN (?)');
    expect(conn.query.mock.calls[1][0]).toContain('COALESCE(ap.request_body, ar.request_body)');
    expect(conn.query.mock.calls[2][0]).toContain('COALESCE(ap.response_body, ar.response_body)');
    expect(conn.query.mock.calls[2][1]).toEqual(['r1', 'k1']);
    expect(detail).toMatchObject({ request_body: 'request', response_body: 'response' });
  });
  it('never queries the database for an empty scope', async () => {
    conn.query.mockClear();
    const result = await userApiRequestRepository.listForVirtualKeys({ virtualKeyIds: [], limit: 20, offset: 0 });
    expect(result.total).toBe(0);
    expect(await userApiRequestRepository.getByIdForVirtualKeys('r1', [])).toBeUndefined();
    expect(conn.query).not.toHaveBeenCalled();
  });
});
