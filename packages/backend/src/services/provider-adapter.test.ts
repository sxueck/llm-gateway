import { describe, expect, it } from 'bun:test'

import { ProviderAdapterFactory } from './provider-adapter.js'

describe('ProviderAdapterFactory Anthropic normalization', () => {
  it('removes a trailing /v1 suffix for Anthropic providers', () => {
    const normalized = ProviderAdapterFactory.normalizeProviderConfig({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      protocol: 'anthropic'
    })

    expect(normalized.baseUrl).toBe('https://api.example.com')
  })

  it('preserves provider-specific path prefixes while removing only the trailing /v1 suffix', () => {
    const normalized = ProviderAdapterFactory.normalizeProviderConfig({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com/claude/v1',
      apiKey: 'sk-test',
      protocol: 'anthropic'
    })

    expect(normalized.baseUrl).toBe('https://api.example.com/claude')
  })

  it('keeps non-v1 Anthropic base URLs unchanged', () => {
    const normalized = ProviderAdapterFactory.normalizeProviderConfig({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com/claude',
      apiKey: 'sk-test',
      protocol: 'anthropic'
    })

    expect(normalized.baseUrl).toBe('https://api.example.com/claude')
  })
})
