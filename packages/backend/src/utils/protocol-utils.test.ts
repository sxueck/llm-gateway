import { describe, expect, it } from 'vitest';

import { getProviderSupportedProtocols } from './protocol-utils.js';

describe('getProviderSupportedProtocols', () => {
  it('derives openai from base_url alone', () => {
    expect(
      getProviderSupportedProtocols({ base_url: 'https://api.example.com', protocol_mappings: null }),
    ).toEqual(['openai']);
  });

  it('merges protocols declared via protocol_mappings in canonical order', () => {
    expect(
      getProviderSupportedProtocols({
        base_url: 'https://api.example.com',
        protocol_mappings: JSON.stringify({
          google: 'https://api.example.com/v1beta',
          anthropic: 'https://api.example.com',
        }),
      }),
    ).toEqual(['openai', 'anthropic', 'google']);
  });

  it('ignores mapping entries with empty URLs', () => {
    expect(
      getProviderSupportedProtocols({
        base_url: 'https://api.example.com',
        protocol_mappings: JSON.stringify({ anthropic: '  ' }),
      }),
    ).toEqual(['openai']);
  });

  it('falls back to base_url when protocol_mappings is malformed JSON', () => {
    expect(
      getProviderSupportedProtocols({
        base_url: 'https://api.example.com',
        protocol_mappings: '{invalid',
      }),
    ).toEqual(['openai']);
  });

  it('returns an empty list for a provider without any usable endpoint', () => {
    expect(getProviderSupportedProtocols(null)).toEqual([]);
    expect(getProviderSupportedProtocols({ base_url: '', protocol_mappings: null })).toEqual([]);
  });
});
