import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveWebSocketTurnConfig } from './ws-handler.js';
import { resolveModelAndProvider } from '../proxy/model-resolver.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';

vi.mock('../proxy/model-resolver.js', () => ({
  resolveModelAndProvider: vi.fn(),
}));

vi.mock('../proxy/provider-config-builder.js', () => ({
  buildProviderConfig: vi.fn(),
}));

describe('resolveWebSocketTurnConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the model from response.create instead of the WebSocket handshake request', async () => {
    const handshakeRequest = {
      body: { model: 'Qwen3-Embedding-8B' },
      headers: { authorization: 'Bearer vk-test' },
      method: 'GET',
      url: '/v1/responses',
    } as any;

    const virtualKey = { id: 'vk-id' };
    const normalizedRequest = {
      body: { model: 'gpt-5.5', input: 'hi', stream: true },
      stream: true,
    };

    vi.mocked(resolveModelAndProvider).mockImplementation(async (_virtualKey, request) => {
      expect((request.body as any).model).toBe('gpt-5.5');
      return {
        provider: { id: 'gpt-provider' },
        providerId: 'gpt-provider',
        currentModel: { name: 'gpt-5.5', supported_protocols: JSON.stringify(['openai']), health_check_protocol: 'openai' },
      } as any;
    });

    vi.mocked(buildProviderConfig).mockImplementation(async (_provider, _virtualKey, _virtualKeyValue, providerId, request, _currentModel, entrypointProtocol) => {
      expect(providerId).toBe('gpt-provider');
      expect((request.body as any).model).toBe('gpt-5.5');
      expect(entrypointProtocol).toBe('openai');
      return {
        protocolConfig: {
          protocol: 'openai',
          baseUrl: 'https://upstream.example/v1',
          apiKey: 'sk-test',
          model: 'gpt-5.5',
          upstreamTransport: 'websocket',
        },
        path: '/v1/responses',
        vkDisplay: 'vk-test',
        isStreamRequest: true,
      } as any;
    });

    const result = await resolveWebSocketTurnConfig(
      handshakeRequest,
      virtualKey,
      'vk-test',
      normalizedRequest as any
    );

    expect(result.providerId).toBe('gpt-provider');
    expect(result.protocolConfig.model).toBe('gpt-5.5');
    expect(resolveModelAndProvider).toHaveBeenCalledOnce();
    expect(buildProviderConfig).toHaveBeenCalledOnce();
  });
});
