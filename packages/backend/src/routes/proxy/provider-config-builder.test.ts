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
