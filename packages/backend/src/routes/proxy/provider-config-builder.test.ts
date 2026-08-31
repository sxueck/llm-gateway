import { describe, expect, it } from 'vitest';

import { encryptApiKey } from '../../utils/crypto.js';
import { buildProviderConfig } from './provider-config-builder.js';

const provider = {
  id: 'provider-test',
  api_key: encryptApiKey('sk-test-secret'),
  base_url: 'https://default.example/v1',
  protocol_mappings: JSON.stringify({
    openai: 'https://openai.example/v1',
    anthropic: 'https://anthropic.example/v1',
    google: 'https://google.example/v1beta/openai',
  }),
};

const virtualKey = { cache_enabled: 0 };
const request = {
  method: 'POST',
  url: '/v1/chat/completions',
  body: { model: 'client-model' },
} as any;

function modelWithProtocols(protocols: string[]) {
  return {
    name: 'configured-model',
    model_identifier: 'upstream-model',
    supported_protocols: JSON.stringify(protocols),
    health_check_protocol: protocols[0] ?? null,
    model_attributes: null,
  };
}

describe('buildProviderConfig protocol selection', () => {
  it.each([
    ['openai', 'openai'],
    ['anthropic', 'anthropic'],
    ['gemini', 'google'],
  ] as const)('uses %s entrypoint as %s upstream protocol', async (entrypointProtocol, expectedProtocol) => {
    const result = await buildProviderConfig(
      provider,
      virtualKey,
      'vk-test-value',
      provider.id,
      request,
      modelWithProtocols(['openai', 'anthropic', 'google']),
      entrypointProtocol
    );

    expect('code' in result).toBe(false);
    if ('code' in result) return;

    expect(result.protocolConfig.protocol).toBe(expectedProtocol);
    expect(result.protocolConfig.baseUrl).toContain(`${expectedProtocol === 'google' ? 'google' : expectedProtocol}.example`);
  });

  it('returns unsupported_model_protocol when final model does not allow the effective protocol', async () => {
    const result = await buildProviderConfig(
      provider,
      virtualKey,
      'vk-test-value',
      provider.id,
      request,
      modelWithProtocols(['openai']),
      'anthropic'
    );

    expect(result).toMatchObject({
      code: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_model_protocol',
        },
      },
    });
  });
});

describe('buildProviderConfig upstream model mapping', () => {
  function makeRequest(model: string) {
    return {
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model },
    } as any;
  }

  it('maps client-facing display name to model_identifier for real models', async () => {
    const result = await buildProviderConfig(
      provider,
      virtualKey,
      'vk-test-value',
      provider.id,
      makeRequest('configured-model'),
      modelWithProtocols(['openai']),
      'openai'
    );

    expect('code' in result).toBe(false);
    if ('code' in result) return;
    expect(result.protocolConfig.model).toBe('upstream-model');
  });

  it('keeps model_identifier requests unchanged', async () => {
    const result = await buildProviderConfig(
      provider,
      virtualKey,
      'vk-test-value',
      provider.id,
      makeRequest('upstream-model'),
      modelWithProtocols(['openai']),
      'openai'
    );

    expect('code' in result).toBe(false);
    if ('code' in result) return;
    expect(result.protocolConfig.model).toBe('upstream-model');
  });

  it('skips mapping for virtual models (identifier is internal)', async () => {
    const virtualModel = {
      ...modelWithProtocols(['openai']),
      name: 'grok-4.6',
      model_identifier: 'virtual-123',
      is_virtual: 1,
      routing_config_id: 1,
    };
    const result = await buildProviderConfig(
      provider,
      virtualKey,
      'vk-test-value',
      provider.id,
      // 智能路由已把 override_params.model 改写进 body.model
      makeRequest('xai/grok-4.6'),
      virtualModel,
      'openai'
    );

    expect('code' in result).toBe(false);
    if ('code' in result) return;
    expect(result.protocolConfig.model).toBe('xai/grok-4.6');
  });

  it('passes client model through when no model record was resolved', async () => {
    const result = await buildProviderConfig(
      provider,
      virtualKey,
      'vk-test-value',
      provider.id,
      makeRequest('any-model-string'),
      undefined,
      'openai'
    );

    expect('code' in result).toBe(false);
    if ('code' in result) return;
    expect(result.protocolConfig.model).toBe('any-model-string');
  });
});
