import { expect, test } from 'vitest';
import { isPrivateNodeOrigin } from './node-origin.js';
import { parseNodeConfig } from '../config/node.js';

test('peer plaintext is limited to literal private addresses and loopback', () => {
  for (const origin of ['https://node-b.example.test', 'http://127.0.0.1:3000', 'http://localhost:3000', 'http://10.90.0.2', 'http://172.16.0.1', 'http://192.168.1.1', 'http://[::1]', 'http://[fd00::1]']) {
    expect(isPrivateNodeOrigin(origin), origin).toBe(true);
  }
  for (const origin of ['http://node-b.example.test', 'http://8.8.8.8', 'http://172.32.0.1', 'http://127.evil.test', 'ftp://10.0.0.1', 'invalid']) {
    expect(isPrivateNodeOrigin(origin), origin).toBe(false);
  }
});

test('node configuration rejects public HTTP and inherited peer properties', () => {
  const base = { GATEWAY_NODE_ID: 'node-a', GATEWAY_CONTROL_NODE_ID: 'node-a', GATEWAY_NODE_SECRET: "node-test-".repeat(4) };
  expect(() => parseNodeConfig({ ...base, GATEWAY_NODE_PEERS: '{"node-b":"http://node-b.example.test"}' })).toThrow(/HTTPS/);
  expect(() => parseNodeConfig({ ...base, GATEWAY_CONTROL_NODE_ID: 'constructor', GATEWAY_NODE_PEERS: '{}' })).toThrow(/GATEWAY_CONTROL_NODE_ID/);
});
