import { describe, it, expect } from 'vitest';
import { deriveWebSocketUrl } from './websocket-proxy.js';

describe('deriveWebSocketUrl', () => {
  it('should convert https:// to wss://', () => {
    expect(deriveWebSocketUrl('https://api.openai.com/v1', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should convert http:// to ws://', () => {
    expect(deriveWebSocketUrl('http://localhost:3000/v1', '/responses'))
      .toBe('ws://localhost:3000/v1/responses');
  });

  it('should preserve existing wss://', () => {
    expect(deriveWebSocketUrl('wss://api.openai.com/v1', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should default to wss:// when no protocol is given', () => {
    expect(deriveWebSocketUrl('api.openai.com/v1', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should trim trailing slashes from base URL', () => {
    expect(deriveWebSocketUrl('https://api.openai.com/v1///', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should handle path without leading slash', () => {
    expect(deriveWebSocketUrl('https://api.openai.com/v1', 'responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should handle v1/responses path', () => {
    expect(deriveWebSocketUrl('https://api.openai.com', '/v1/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });
});
