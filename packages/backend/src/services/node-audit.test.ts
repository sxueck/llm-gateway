import { beforeEach, expect, test, vi } from 'vitest';
import { appConfig } from '../config/index.js';
import { nodeAuditContext } from './node-audit.js';
import { logApiRequestToDb } from './api-request-logger.js';

const create = vi.hoisted(() => vi.fn());
vi.mock('../db/index.js', () => ({ apiRequestDb: { create } }));
const params = { virtualKey: { id: 'vk', disable_logging: 0 } as any, providerId: 'provider', model: 'model', tokenCount: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, status: 'success' as const, responseTime: 1 };
beforeEach(() => {
  create.mockClear();
  appConfig.node = { enabled: true, id: 'node-b', controlId: 'node-a', peers: {}, secret: "node-test-".repeat(4) };
});

test('async owner audit keeps ingress correlation and distinct attempt rows', async () => {
  await nodeAuditContext.run({ requestId: 'logical-request', ingressNode: 'node-a', executionNode: 'node-b' }, async () => {
    await Promise.resolve();
    await logApiRequestToDb(params);
    await logApiRequestToDb(params);
  });
  const rows = create.mock.calls.map(call => call[0]);
  expect(rows[0].id).not.toBe(rows[1].id);
  for (const row of rows) {
    expect(JSON.parse(row.request_params_json)).toEqual({ ingress_node: 'node-a', execution_node: 'node-b', node_request_id: 'logical-request' });
    expect(row.total_tokens).toBe(3);
  }
});

test('disabled detailed logging omits request correlation but retains node attribution', async () => {
  await nodeAuditContext.run({ requestId: 'private-request', ingressNode: 'node-a', executionNode: 'node-b' }, () => logApiRequestToDb({ ...params, virtualKey: { id: 'vk', disable_logging: 1 } as any }));
  expect(JSON.parse(create.mock.calls[0][0].request_params_json)).toEqual({ ingress_node: 'node-a', execution_node: 'node-b' });
});
