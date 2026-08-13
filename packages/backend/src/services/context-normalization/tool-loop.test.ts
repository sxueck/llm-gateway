import { describe, expect, test } from 'vitest';

import { detectUnfinishedToolLoop, validateSequence } from './tool-loop.js';

describe('detectUnfinishedToolLoop', () => {
  describe('openai chat', () => {
    test('false when no tool calls exist', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
          ],
        })
      ).toBe(false);
    });

    test('true when last assistant tool call has no tool result', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          messages: [
            { role: 'user', content: 'search' },
            { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'search' } }] },
          ],
        })
      ).toBe(true);
    });

    test('false when all last assistant tool calls have results', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          messages: [
            { role: 'user', content: 'search' },
            { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'search' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'result' },
          ],
        })
      ).toBe(false);
    });

    test('true when only some tool calls have results', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
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
        })
      ).toBe(true);
    });
  });

  describe('openai responses', () => {
    test('true when last function_call has no output', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          input: [
            { type: 'message', role: 'user', content: 'x' },
            { type: 'function_call', call_id: 'fc_1', name: 'search' },
          ],
        })
      ).toBe(true);
    });

    test('false when function_call_output follows', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          input: [
            { type: 'message', role: 'user', content: 'x' },
            { type: 'function_call', call_id: 'fc_1', name: 'search' },
            { type: 'function_call_output', call_id: 'fc_1', output: 'ok' },
          ],
        })
      ).toBe(false);
    });

    test('true when a parallel function_call before a reasoning item is unanswered', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          input: [
            { type: 'function_call', call_id: 'fc_a', name: 'search' },
            { type: 'reasoning', id: 'r1' },
            { type: 'function_call', call_id: 'fc_b', name: 'lookup' },
            { type: 'function_call_output', call_id: 'fc_b', output: 'ok' },
          ],
        })
      ).toBe(true);
    });

    test('true when an earlier parallel function_call is unanswered', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          input: [
            { type: 'message', role: 'user', content: 'x' },
            { type: 'function_call', call_id: 'fc_a', name: 'search' },
            { type: 'function_call', call_id: 'fc_b', name: 'lookup' },
            { type: 'function_call_output', call_id: 'fc_b', output: 'ok' },
          ],
        })
      ).toBe(true);
    });

    test('false when every parallel function_call has an output', () => {
      expect(
        detectUnfinishedToolLoop('openai', {
          input: [
            { type: 'function_call', call_id: 'fc_a', name: 'search' },
            { type: 'function_call', call_id: 'fc_b', name: 'lookup' },
            { type: 'function_call_output', call_id: 'fc_a', output: 'a' },
            { type: 'function_call_output', call_id: 'fc_b', output: 'b' },
          ],
        })
      ).toBe(false);
    });
  });

  describe('anthropic', () => {
    test('true when last assistant tool_use has no tool_result', () => {
      expect(
        detectUnfinishedToolLoop('anthropic', {
          messages: [
            { role: 'user', content: 'x' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: {} }] },
          ],
        })
      ).toBe(true);
    });

    test('false when tool_result follows', () => {
      expect(
        detectUnfinishedToolLoop('anthropic', {
          messages: [
            { role: 'user', content: 'x' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
          ],
        })
      ).toBe(false);
    });
  });

  describe('gemini', () => {
    test('true when last model functionCall has no functionResponse', () => {
      expect(
        detectUnfinishedToolLoop('gemini', {
          contents: [
            { role: 'user', parts: [{ text: 'x' }] },
            { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
          ],
        })
      ).toBe(true);
    });

    test('false when functionResponse follows', () => {
      expect(
        detectUnfinishedToolLoop('gemini', {
          contents: [
            { role: 'user', parts: [{ text: 'x' }] },
            { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'search', response: {} } }] },
          ],
        })
      ).toBe(false);
    });
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
