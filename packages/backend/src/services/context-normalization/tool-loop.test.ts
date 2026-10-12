import { describe, expect, test } from 'vitest';

import { detectUnfinishedToolLoop, validateSequence } from './tool-loop.js';

describe('detectUnfinishedToolLoop', () => {
  const detectCases = [
    ['openai chat: no tool calls exist', 'openai', { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }, false],
    ['openai chat: last assistant tool call has no tool result', 'openai', { messages: [{ role: 'user', content: 'search' }, { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'search' } }] }] }, true],
    ['openai chat: all last assistant tool calls have results', 'openai', { messages: [{ role: 'user', content: 'search' }, { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'search' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'result' }] }, false],
    [
      'openai chat: only some tool calls have results',
      'openai',
      {
        messages: [
          { role: 'user', content: 'search' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', function: { name: 'a' } },
              { id: 'call_2', function: { name: 'b' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'r1' },
        ],
      },
      true,
    ],
    ['openai responses: last function_call has no output', 'openai', { input: [{ type: 'message', role: 'user', content: 'x' }, { type: 'function_call', call_id: 'fc_1', name: 'search' }] }, true],
    ['openai responses: function_call_output follows', 'openai', { input: [{ type: 'message', role: 'user', content: 'x' }, { type: 'function_call', call_id: 'fc_1', name: 'search' }, { type: 'function_call_output', call_id: 'fc_1', output: 'ok' }] }, false],
    [
      'openai responses: a parallel function_call before a reasoning item is unanswered',
      'openai',
      {
        input: [
          { type: 'function_call', call_id: 'fc_a', name: 'search' },
          { type: 'reasoning', id: 'r1' },
          { type: 'function_call', call_id: 'fc_b', name: 'lookup' },
          { type: 'function_call_output', call_id: 'fc_b', output: 'ok' },
        ],
      },
      true,
    ],
    [
      'openai responses: an earlier parallel function_call is unanswered',
      'openai',
      {
        input: [
          { type: 'message', role: 'user', content: 'x' },
          { type: 'function_call', call_id: 'fc_a', name: 'search' },
          { type: 'function_call', call_id: 'fc_b', name: 'lookup' },
          { type: 'function_call_output', call_id: 'fc_b', output: 'ok' },
        ],
      },
      true,
    ],
    [
      'openai responses: every parallel function_call has an output',
      'openai',
      {
        input: [
          { type: 'function_call', call_id: 'fc_a', name: 'search' },
          { type: 'function_call', call_id: 'fc_b', name: 'lookup' },
          { type: 'function_call_output', call_id: 'fc_a', output: 'a' },
          { type: 'function_call_output', call_id: 'fc_b', output: 'b' },
        ],
      },
      false,
    ],
    ['anthropic: last assistant tool_use has no tool_result', 'anthropic', { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: {} }] }] }, true],
    ['anthropic: tool_result follows', 'anthropic', { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }] }, false],
    ['gemini: last model functionCall has no functionResponse', 'gemini', { contents: [{ role: 'user', parts: [{ text: 'x' }] }, { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] }] }, true],
    ['gemini: functionResponse follows', 'gemini', { contents: [{ role: 'user', parts: [{ text: 'x' }] }, { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { name: 'search', response: {} } }] }] }, false],
  ] as Array<[string, 'openai' | 'anthropic' | 'gemini', Record<string, any>, boolean]>;
  test('detects unfinished tool loops across protocols', () => {
    for (const [_label, protocol, body, expected] of detectCases) {
      expect(detectUnfinishedToolLoop(protocol, body)).toBe(expected);
    }
  });
});

describe('validateSequence', () => {
  test('openai is always valid (accepts consecutive same role)', () => {
    expect(
      validateSequence('openai', [
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
      ])
    ).toBe(true);
  });

  test('anthropic: consecutive same role is invalid', () => {
    expect(
      validateSequence('anthropic', [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ])
    ).toBe(false);
  });

  test('anthropic: alternating roles is valid', () => {
    expect(
      validateSequence('anthropic', [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ])
    ).toBe(true);
  });

  test('gemini: consecutive same role is invalid', () => {
    expect(
      validateSequence('gemini', [
        { role: 'user', parts: [{ text: 'a' }] },
        { role: 'user', parts: [{ text: 'b' }] },
      ])
    ).toBe(false);
  });

  test('gemini: alternating roles is valid', () => {
    expect(
      validateSequence('gemini', [
        { role: 'user', parts: [{ text: 'a' }] },
        { role: 'model', parts: [{ text: 'b' }] },
      ])
    ).toBe(true);
  });
});
