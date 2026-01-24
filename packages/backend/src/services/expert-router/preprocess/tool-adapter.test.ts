
import { describe, it, expect } from 'bun:test';
import { ToolAdapter } from './tool-adapter.js';
import { ProxyRequest } from '../types.js';

describe('ToolAdapter', () => {
  it('extracts OpenAI tool calls', () => {
    const request: ProxyRequest = {
      body: {
        messages: [
          { role: 'user', content: 'Use tool' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"location":"London"}' }
              }
            ]
          }
        ]
      }
    };

    const signals = ToolAdapter.extractToolSignals(request);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('call');
    expect(signals[0].name).toBe('get_weather');
    expect(signals[0].content).toBe('"{\\"location\\":\\"London\\"}"');
  });

  it('extracts OpenAI tool results (success)', () => {
    const request: ProxyRequest = {
      body: {
        messages: [
          { role: 'tool', content: '{"temp": 20}' }
        ]
      }
    };

    const signals = ToolAdapter.extractToolSignals(request);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('result');
    expect(signals[0].isError).toBe(false);
  });

  it('detects OpenAI tool results (error)', () => {
    const request: ProxyRequest = {
      body: {
        messages: [
          { role: 'tool', content: 'Error: Failed to connect' }
        ]
      }
    };

    const signals = ToolAdapter.extractToolSignals(request);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('result');
    expect(signals[0].isError).toBe(true);
  });

  it('extracts Anthropic tool use', () => {
    const request: ProxyRequest = {
      body: {
        messages: [
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Thinking...' },
                    { type: 'tool_use', name: 'search', input: { query: 'bun' } }
                ]
            }
        ]
      }
    };

    const signals = ToolAdapter.extractToolSignals(request);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('call');
    expect(signals[0].name).toBe('search');
    expect(signals[0].content).toContain('"query":"bun"');
  });
});
