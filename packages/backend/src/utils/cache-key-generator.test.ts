import { describe, expect, test } from 'vitest';

import { generateCacheKey, generateCacheKeyWithDebug } from './cache-key-generator.js';

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Explain this' }],
    ...overrides,
  };
}

test('generates distinct keys for different reasoning efforts', () => {
  const baseRequest = {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Explain this' }],
  };

  const lowKey = generateCacheKey({ ...baseRequest, reasoning_effort: 'low' }, 'vk-1');
  const highKey = generateCacheKey({ ...baseRequest, reasoning_effort: 'high' }, 'vk-1');

  expect(lowKey).not.toBe(highKey);
});

describe('output-affecting controls must not collide', () => {
  const cases: Record<string, Record<string, unknown>> = {
    tools: {
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        },
      ],
    },
    tool_choice: { tool_choice: 'required' },
    response_format: { response_format: { type: 'json_object' } },
    max_completion_tokens: { max_completion_tokens: 512 },
    seed: { seed: 42 },
    parallel_tool_calls: { parallel_tool_calls: true },
    user: { user: 'user-abc' },
    'unknown extra field': { top_k: 40 },
  };

  for (const [label, field] of Object.entries(cases)) {
    test(`differing ${label} yields distinct keys`, () => {
      const plainKey = generateCacheKey(baseRequest(), 'vk-1');
      const withFieldKey = generateCacheKey(baseRequest(field), 'vk-1');
      expect(withFieldKey).not.toBe(plainKey);
    });
  }
});

describe('semantically equal requests must collide', () => {
  test('same key regardless of top-level field ordering', () => {
    const a = generateCacheKey({ model: 'gpt-5', temperature: 0.5, messages: [{ role: 'user', content: 'hi' }] }, 'vk-1');
    const b = generateCacheKey({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.5, model: 'gpt-5' }, 'vk-1');
    expect(a).toBe(b);
  });

  test('same key regardless of nested object key ordering (response_format json_schema)', () => {
    const formatA = {
      type: 'json_schema',
      json_schema: {
        name: 'reply',
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['answer'],
        },
      },
    };
    const formatB = {
      json_schema: {
        schema: {
          required: ['answer'],
          properties: {
            confidence: { type: 'number' },
            answer: { type: 'string' },
          },
          type: 'object',
        },
        name: 'reply',
      },
      type: 'json_schema',
    };

    const a = generateCacheKey(baseRequest({ response_format: formatA }), 'vk-1');
    const b = generateCacheKey(baseRequest({ response_format: formatB }), 'vk-1');
    expect(a).toBe(b);
  });

  test('same key regardless of nested object key ordering inside tools', () => {
    const toolsA = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' }, unit: { type: 'string' } },
          },
        },
      },
    ];
    const toolsB = [
      {
        function: {
          parameters: {
            properties: { unit: { type: 'string' }, city: { type: 'string' } },
            type: 'object',
          },
          description: 'Get weather',
          name: 'get_weather',
        },
        type: 'function',
      },
    ];

    const a = generateCacheKey(baseRequest({ tools: toolsA }), 'vk-1');
    const b = generateCacheKey(baseRequest({ tools: toolsB }), 'vk-1');
    expect(a).toBe(b);
  });

  test('same key regardless of key ordering in structured message content', () => {
    const a = generateCacheKey({ model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', extra: { x: 1, y: 2 } }] }] }, 'vk-1');
    const b = generateCacheKey({ model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', extra: { y: 2, x: 1 } }] }] }, 'vk-1');
    expect(a).toBe(b);
  });

  test('explicit null is equivalent to an omitted field', () => {
    const a = generateCacheKey(baseRequest({ seed: null }), 'vk-1');
    const b = generateCacheKey(baseRequest(), 'vk-1');
    expect(a).toBe(b);
  });
});

describe('existing normalization is preserved', () => {
  test('model casing does not change the key', () => {
    expect(generateCacheKey(baseRequest({ model: 'GPT-5' }), 'vk-1')).toBe(generateCacheKey(baseRequest({ model: 'gpt-5' }), 'vk-1'));
  });

  test('float rounding does not change the key', () => {
    expect(generateCacheKey(baseRequest({ temperature: 0.1234 }), 'vk-1')).toBe(generateCacheKey(baseRequest({ temperature: 0.123 }), 'vk-1'));
    expect(generateCacheKey(baseRequest({ top_p: 0.99999 }), 'vk-1')).toBe(generateCacheKey(baseRequest({ top_p: 1.0 }), 'vk-1'));
  });

  test('stop normalization does not change the key', () => {
    const a = generateCacheKey(baseRequest({ stop: '  END  ' }), 'vk-1');
    const b = generateCacheKey(baseRequest({ stop: 'END' }), 'vk-1');
    expect(a).toBe(b);

    const c = generateCacheKey(baseRequest({ stop: [' a ', 'b '] }), 'vk-1');
    const d = generateCacheKey(baseRequest({ stop: ['a', 'b'] }), 'vk-1');
    expect(c).toBe(d);
  });

  test('stream is excluded as transport-only', () => {
    expect(generateCacheKey(baseRequest({ stream: true }), 'vk-1')).toBe(generateCacheKey(baseRequest(), 'vk-1'));
    expect(generateCacheKey(baseRequest({ stream: true, stream_options: { include_usage: true } }), 'vk-1')).toBe(generateCacheKey(baseRequest(), 'vk-1'));
  });

  test('array order remains significant (tools order)', () => {
    const toolsA = [
      { type: 'function', function: { name: 'a' } },
      { type: 'function', function: { name: 'b' } },
    ];
    const toolsB = [
      { type: 'function', function: { name: 'b' } },
      { type: 'function', function: { name: 'a' } },
    ];
    expect(generateCacheKey(baseRequest({ tools: toolsA }), 'vk-1')).not.toBe(generateCacheKey(baseRequest({ tools: toolsB }), 'vk-1'));
  });
});

describe('key identity and scoping', () => {
  test('different virtual key ids yield distinct keys', () => {
    expect(generateCacheKey(baseRequest(), 'vk-1')).not.toBe(generateCacheKey(baseRequest(), 'vk-2'));
  });

  test('different messages yield distinct keys', () => {
    expect(generateCacheKey(baseRequest(), 'vk-1')).not.toBe(generateCacheKey(baseRequest({ messages: [{ role: 'user', content: 'different' }] }), 'vk-1'));
  });

  test('generateCacheKeyWithDebug agrees with generateCacheKey', () => {
    const request = baseRequest({
      tools: [
        {
          type: 'function',
          function: { name: 'f', parameters: { b: 2, a: 1 } },
        },
      ],
      seed: 7,
    });
    const debug = generateCacheKeyWithDebug(request, 'vk-1');
    expect(debug.key).toBe(generateCacheKey(request, 'vk-1'));
    // canonical (sorted) representation is exposed for debugging
    expect(debug.json).toContain('"a":1');
    expect(debug.json.indexOf('"b"')).toBeGreaterThan(debug.json.indexOf('"a"'));
  });
});
