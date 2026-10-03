import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appConfig } from '../config/index.js';

const mocks = vi.hoisted(() => ({
  fetchNodePayload: vi.fn(),
  upstreamFetch: vi.fn(),
}));

vi.mock('./node-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node-dispatch.js')>();
  return { ...actual, fetchNodePayload: mocks.fetchNodePayload };
});

vi.mock('../utils/upstream-fetch.js', () => ({ upstreamFetch: mocks.upstreamFetch }));

import { probeModelViaProvider } from './probe-service.js';

// 本节点 'node-a' 为控制节点，'node-b' 持有远端提供商。
const CONTROL_NODE = { enabled: true, id: 'node-a', controlId: 'node-a', peers: { "node-b": 'http://127.0.0.1:2' }, secret: "node-test-".repeat(4) };
const DISABLED_NODE = { enabled: false, id: 'local', controlId: 'local', peers: {}, secret: '' };

const remoteProvider = {
  id: 'p1',
  owner_node: 'node-b',
  base_url: 'https://node-b.example.com/v1',
  protocol_mappings: null,
};

const ownerResult = {
  chat: { success: true, status: 200, message: 'Chat 测试成功', responseTime: 11, response: { content: 'hi' } },
  responses: { success: false, message: 'Responses 测试失败: HTTP 404', responseTime: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  appConfig.node = { ...CONTROL_NODE };
});

afterEach(() => {
  appConfig.node = { ...DISABLED_NODE };
});

describe('probeModelViaProvider remote routing', () => {
  test('routes remote providers to the owner node before any local HTTP and never transmits the key', async () => {
    mocks.fetchNodePayload.mockResolvedValue({ ok: true, status: 200, json: async () => ownerResult });

    const result = await probeModelViaProvider({
      modelIdentifier: 'gpt-x',
      protocol: 'openai',
      provider: remoteProvider,
      apiKey: 'sk-local-decrypted',
      prompt: '测试',
      timeoutMs: 30000,
    });

    expect(mocks.fetchNodePayload).toHaveBeenCalledWith(
      'node-b',
      expect.objectContaining({ op: 'model-probe', providerId: 'p1', modelIdentifier: 'gpt-x', protocol: 'openai', timeoutMs: 30000 }),
      expect.any(AbortSignal),
    );
    const sent = mocks.fetchNodePayload.mock.calls[0][1];
    expect(JSON.stringify(sent)).not.toContain('sk-local-decrypted');
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    expect(result).toEqual(ownerResult);
  });

  test('maps owner refusals (ownership changed) to a failed probe without local fallback', async () => {
    mocks.fetchNodePayload.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'owner_node_mismatch', message: 'x' } }),
    });

    const result = await probeModelViaProvider({
      modelIdentifier: 'gpt-x',
      protocol: 'openai',
      provider: remoteProvider,
      apiKey: 'sk-local-decrypted',
    });

    expect(result.chat.success).toBe(false);
    expect(result.chat.message).toContain('409');
    expect(result.chat.message).toContain('owner_node_mismatch');
    expect(result.responses.success).toBe(false);
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  test('returns a failed result when the owner node is unreachable (no local takeover)', async () => {
    mocks.fetchNodePayload.mockRejectedValue(new Error('owner_node_unconfigured'));

    const result = await probeModelViaProvider({
      modelIdentifier: 'gpt-x',
      protocol: 'openai',
      provider: remoteProvider,
      apiKey: 'sk-local-decrypted',
    });

    expect(result.chat.success).toBe(false);
    expect(result.chat.message).toContain("owner 节点 'node-b' 不可用");
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  test('refuses remote providers without an id instead of probing locally', async () => {
    const result = await probeModelViaProvider({
      modelIdentifier: 'gpt-x',
      protocol: 'openai',
      provider: { owner_node: 'node-b', base_url: 'https://node-b.example.com/v1', protocol_mappings: null },
      apiKey: 'sk-local-decrypted',
    });

    expect(result.chat.success).toBe(false);
    expect(mocks.fetchNodePayload).not.toHaveBeenCalled();
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });
});

describe('probeModelViaProvider local execution', () => {
  test('probes owned providers directly via upstreamFetch', async () => {
    const provider = { id: 'p1', owner_node: null, base_url: 'https://api.example.com/v1', protocol_mappings: null };
    mocks.upstreamFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 3 } }),
    });

    const result = await probeModelViaProvider({
      modelIdentifier: 'gpt-x',
      protocol: 'openai',
      provider,
      apiKey: 'sk-local',
    });

    expect(mocks.fetchNodePayload).not.toHaveBeenCalled();
    expect(mocks.upstreamFetch).toHaveBeenCalledTimes(2);
    const authHeaders = mocks.upstreamFetch.mock.calls.map((call: any[]) => call[1].headers.Authorization);
    expect(authHeaders).toEqual(['Bearer sk-local', 'Bearer sk-local']);
    expect(result.chat.success).toBe(true);
    expect(result.chat.response?.content).toBe('hi');
    expect(result.responses.success).toBe(true);
  });
});
