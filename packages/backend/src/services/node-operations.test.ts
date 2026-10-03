import net from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appConfig } from '../config/index.js';

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  decryptApiKey: vi.fn(),
  upstreamFetch: vi.fn(),
  probeLocal: vi.fn(),
  fetchNodePayload: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ providerDb: { getById: mocks.provider } }));
vi.mock('../utils/crypto.js', () => ({
  encryptApiKey: vi.fn(),
  decryptApiKey: mocks.decryptApiKey,
}));
vi.mock('../utils/upstream-fetch.js', () => ({ upstreamFetch: mocks.upstreamFetch }));
vi.mock('./probe-service.js', () => ({ probeModelViaProviderLocal: mocks.probeLocal }));
vi.mock('./node-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node-dispatch.js')>();
  return { ...actual, fetchNodePayload: mocks.fetchNodePayload };
});

import {
  executeProviderTestLocally,
  fetchUpstreamModelsLocally,
  forwardNodeOperation,
  handleNodeOperation,
  isPrivateNodeTransport,
} from './node-operations.js';

// 本节点为 owner 节点 'node-b'，控制节点为 'node-a'。
const OWNER_NODE = { enabled: true, id: 'node-b', controlId: 'node-a', peers: { "node-a": 'http://127.0.0.1:2' }, secret: "node-test-".repeat(4) };
const CONTROL_NODE = { ...OWNER_NODE, id: 'node-a', peers: { "node-b": 'http://127.0.0.1:2' } };
const DISABLED_NODE = { enabled: false, id: 'local', controlId: 'local', peers: {}, secret: '' };

function createReply() {
  const reply: any = {
    statusCode: 200,
    payload: undefined,
    code(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.payload = body;
      return reply;
    },
  };
  return reply;
}

function startLocalServer(): Promise<{ server: net.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  appConfig.node = { ...OWNER_NODE };
  mocks.decryptApiKey.mockReturnValue('sk-decrypted');
});

afterEach(() => {
  appConfig.node = { ...DISABLED_NODE };
});

describe('handleNodeOperation payload discrimination', () => {
  test('returns false (untouched reply) for non-operation payloads', async () => {
    const reply = createReply();
    expect(await handleNodeOperation('node-a', null, reply)).toBe(false);
    expect(await handleNodeOperation('node-a', 'provider-test', reply)).toBe(false);
    expect(
      await handleNodeOperation('node-a', { protocol: 'openai', transport: 'http', url: '/v1/chat/completions' }, reply),
    ).toBe(false);
    expect(await handleNodeOperation('node-a', { op: 'reboot' }, reply)).toBe(false);
    // 字段超集/非法字段一律不算操作，交回常规 dispatch 处理
    expect(
      await handleNodeOperation('node-a', { op: 'provider-test', providerId: 'p1', extra: true }, reply),
    ).toBe(false);
    expect(await handleNodeOperation('node-a', { op: 'fetch-models', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }, reply)).toBe(false);
    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toBeUndefined();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});

describe('handleNodeOperation source authorization', () => {
  test('rejects operations from a peer that is not the control node', async () => {
    appConfig.node = { ...CONTROL_NODE };
    const reply = createReply();
    expect(await handleNodeOperation('node-b', { op: 'provider-test', providerId: 'p1' }, reply)).toBe(true);
    expect(reply.statusCode).toBe(403);
    expect(reply.payload.error.code).toBe('node_operation_forbidden');
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  test('rejects operations when node mode is disabled', async () => {
    appConfig.node = { ...DISABLED_NODE };
    const reply = createReply();
    expect(await handleNodeOperation('local', { op: 'provider-test', providerId: 'p1' }, reply)).toBe(true);
    expect(reply.statusCode).toBe(403);
  });
});

describe("operation 'provider-test' on the owner node", () => {
  test('verifies fresh ownership and executes the local TCP test', async () => {
    const { server, baseUrl } = await startLocalServer();
    try {
      mocks.provider.mockResolvedValue({ id: 'p1', owner_node: 'node-b', base_url: baseUrl, api_key: 'enc', enabled: 1 });
      const reply = createReply();
      expect(await handleNodeOperation('node-a', { op: 'provider-test', providerId: 'p1' }, reply)).toBe(true);
      expect(reply.statusCode).toBe(200);
      expect(reply.payload).toMatchObject({ success: true, status: 200, message: '网络连通' });
      expect(typeof reply.payload.latencyMs).toBe('number');
    } finally {
      server.close();
    }
  });

  test('refuses (no bounce, no local takeover) when stored owner is another node', async () => {
    mocks.provider.mockResolvedValue({ id: 'p1', owner_node: 'hk', base_url: 'http://127.0.0.1:1/v1', enabled: 1 });
    const reply = createReply();
    expect(await handleNodeOperation('node-a', { op: 'provider-test', providerId: 'p1' }, reply)).toBe(true);
    expect(reply.statusCode).toBe(409);
    expect(reply.payload.error.code).toBe('owner_node_mismatch');
    // owner_node 为空的提供商归属控制节点，非控制节点不得代为执行
    mocks.provider.mockResolvedValue({ id: 'p1', owner_node: null, base_url: 'http://127.0.0.1:1/v1', enabled: 1 });
    const reply2 = createReply();
    expect(await handleNodeOperation('node-a', { op: 'provider-test', providerId: 'p1' }, reply2)).toBe(true);
    expect(reply2.statusCode).toBe(409);
    expect((await executeProviderTestLocally('p1', 'http://127.0.0.1:1/v1')).success).toBe(false);
  });

  test('returns 404 when the provider no longer exists', async () => {
    mocks.provider.mockResolvedValue(undefined);
    const reply = createReply();
    expect(await handleNodeOperation('node-a', { op: 'provider-test', providerId: 'gone' }, reply)).toBe(true);
    expect(reply.statusCode).toBe(404);
    expect(reply.payload.error.code).toBe('provider_not_found');
  });
});

describe("operation 'fetch-models' on the owner node", () => {
  test('refuses when ownerNode does not match the local 节点 ID', async () => {
    const reply = createReply();
    expect(
      await handleNodeOperation('node-a', { op: 'fetch-models', ownerNode: 'hk', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }, reply),
    ).toBe(true);
    expect(reply.statusCode).toBe(409);
    expect(reply.payload.error.code).toBe('owner_node_mismatch');
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  test('executes locally for the matching owner and maps the model list', async () => {
    mocks.upstreamFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'm1', max_completion_tokens: 8 }] }),
    });
    const reply = createReply();
    expect(
      await handleNodeOperation('node-a', { op: 'fetch-models', ownerNode: 'node-b', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }, reply),
    ).toBe(true);
    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({
      success: true,
      message: '成功获取 1 个模型',
      models: [{ id: 'm1', name: 'm1', max_completion_tokens: 8 }],
    });
    expect(mocks.upstreamFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      { method: 'GET', headers: { Authorization: 'Bearer sk-x' }, timeoutMs: 10000 },
    );
  });

  test('reports upstream failures without leaking credentials', async () => {
    mocks.upstreamFetch.mockResolvedValue({ ok: false, status: 401 });
    const reply = createReply();
    expect(
      await handleNodeOperation('node-a', { op: 'fetch-models', ownerNode: 'node-b', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret' }, reply),
    ).toBe(true);
    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ success: false, message: '获取模型列表失败: HTTP 401', models: [] });
    expect(JSON.stringify(reply.payload)).not.toContain('sk-secret');
  });

  test('local helper surfaces upstream exceptions as failures', async () => {
    mocks.upstreamFetch.mockRejectedValue(new Error('socket hang up'));
    expect(await fetchUpstreamModelsLocally('https://api.example.com/v1', 'sk-x')).toEqual({
      success: false,
      message: 'socket hang up',
      models: [],
    });
  });
});

describe("operation 'model-probe' on the owner node", () => {
  test('decrypts locally and probes only after fresh ownership verification', async () => {
    const provider = { id: 'p1', owner_node: 'node-b', base_url: 'https://node-b.example.com/v1', protocol_mappings: null, api_key: 'enc', enabled: 1 };
    mocks.provider.mockResolvedValue(provider);
    mocks.probeLocal.mockResolvedValue({ chat: { success: true, message: 'Chat 测试成功' }, responses: { success: false, message: 'x' } });
    const reply = createReply();
    expect(
      await handleNodeOperation('node-a', { op: 'model-probe', providerId: 'p1', modelIdentifier: 'gpt-x', protocol: 'openai' }, reply),
    ).toBe(true);
    expect(reply.statusCode).toBe(200);
    expect(reply.payload.chat.success).toBe(true);
    expect(mocks.probeLocal).toHaveBeenCalledWith({
      modelIdentifier: 'gpt-x',
      protocol: 'openai',
      provider,
      apiKey: 'sk-decrypted',
      prompt: '测试',
      timeoutMs: 30000,
    });
  });

  test('refuses stale ownership without probing', async () => {
    mocks.provider.mockResolvedValue({ id: 'p1', owner_node: 'node-a', base_url: 'https://api.example.com/v1', api_key: 'enc', enabled: 1 });
    const reply = createReply();
    expect(
      await handleNodeOperation('node-a', { op: 'model-probe', providerId: 'p1', modelIdentifier: 'gpt-x' }, reply),
    ).toBe(true);
    expect(reply.statusCode).toBe(409);
    expect(mocks.probeLocal).not.toHaveBeenCalled();
    expect(mocks.decryptApiKey).not.toHaveBeenCalled();
  });
});

describe('control-node forwarding helpers', () => {
  test('forwardNodeOperation mirrors owner status/body and rejects on transport failure', async () => {
    mocks.fetchNodePayload.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ success: true, message: '网络连通', latencyMs: 2 }) });
    const outcome = await forwardNodeOperation('node-a', { op: 'provider-test', providerId: 'p1' }, 5000);
    expect(outcome).toEqual({ status: 200, body: { success: true, message: '网络连通', latencyMs: 2 } });
    expect(mocks.fetchNodePayload).toHaveBeenCalledWith('node-a', { op: 'provider-test', providerId: 'p1' }, expect.any(AbortSignal));

    mocks.fetchNodePayload.mockRejectedValue(new Error('owner_node_unconfigured'));
    await expect(forwardNodeOperation('node-a', { op: 'provider-test', providerId: 'p1' }, 5000)).rejects.toThrow('owner_node_unconfigured');
  });

  test('isPrivateNodeTransport only allows https or loopback/private origins', () => {
    expect(isPrivateNodeTransport('node-a', { ...OWNER_NODE, peers: { "node-a": 'https://peer.example.com' } } as any)).toBe(true);
    expect(isPrivateNodeTransport('node-a', { ...OWNER_NODE, peers: { "node-a": 'http://127.0.0.1:2' } } as any)).toBe(true);
    expect(isPrivateNodeTransport('node-a', { ...OWNER_NODE, peers: { "node-a": 'http://10.1.2.3:3000' } } as any)).toBe(true);
    expect(isPrivateNodeTransport('node-a', { ...OWNER_NODE, peers: { "node-a": 'http://192.168.1.4:3000' } } as any)).toBe(true);
    expect(isPrivateNodeTransport('node-a', { ...OWNER_NODE, peers: { "node-a": 'http://172.16.0.9:3000' } } as any)).toBe(true);
    expect(isPrivateNodeTransport('node-a', { ...OWNER_NODE, peers: { "node-a": 'http://172.32.0.9:3000' } } as any)).toBe(false);
    expect(isPrivateNodeTransport('node-a', { ...OWNER_NODE, peers: { "node-a": 'http://peer.example.com' } } as any)).toBe(false);
    expect(isPrivateNodeTransport('missing', OWNER_NODE as any)).toBe(false);
  });
});
