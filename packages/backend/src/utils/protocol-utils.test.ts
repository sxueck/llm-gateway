import { describe, expect, it } from 'vitest';

import { parseSupportedProtocols, resolveProbeProtocol } from './protocol-utils.js';

describe('protocol utils', () => {
  it('defaults missing or empty supported protocols to OpenAI', () => {
    expect(parseSupportedProtocols(null)).toEqual(['openai']);
    expect(parseSupportedProtocols('   ')).toEqual(['openai']);
    expect(parseSupportedProtocols('[]')).toEqual(['openai']);
  });

  it('throws a configuration error for malformed supported protocol JSON', () => {
    expect(() => parseSupportedProtocols('[openai]')).toThrow('supported_protocols 配置错误');
  });

  it('uses health_check_protocol before supported protocol fallback for probes', () => {
    expect(resolveProbeProtocol({
      supported_protocols: JSON.stringify(['openai', 'anthropic']),
      health_check_protocol: 'anthropic',
    })).toBe('anthropic');
  });

  it('falls back to the first supported protocol for probes', () => {
    expect(resolveProbeProtocol({
      supported_protocols: JSON.stringify(['google', 'openai']),
      health_check_protocol: null,
    })).toBe('google');
  });
});
