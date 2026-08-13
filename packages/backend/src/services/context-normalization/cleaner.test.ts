import { describe, expect, test } from 'vitest';

import {
  cleanAnthropicMessages,
  cleanGeminiContents,
  cleanOpenAiMessages,
  cleanResponsesInput,
} from './cleaner.js';

describe('cleanOpenAiMessages', () => {
  test('strips reasoning_content and thinking_blocks from assistant messages', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'secret thoughts',
        thinking_blocks: [{ type: 'thinking', text: 'deep' }],
      },
    ];

    const { payload: cleaned, stats } = cleanOpenAiMessages(messages);

    expect(cleaned[1].reasoning_content).toBeUndefined();
    expect(cleaned[1].thinking_blocks).toBeUndefined();
    expect(cleaned[1].content).toBe('answer');
    expect(stats.cleanedBlocks).toBe(2);
    expect(stats.cleanedChars).toBeGreaterThan(0);
  });

  test('preserves tool_calls and content text', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'using tool',
        tool_calls: [{ id: 'c1', function: { name: 'search' } }],
        reasoning_content: 'thoughts',
      },
    ];

    const { payload: cleaned } = cleanOpenAiMessages(messages);

    expect(cleaned[0].tool_calls).toHaveLength(1);
    expect(cleaned[0].content).toBe('using tool');
  });

  test('deletes assistant message left empty after cleaning (no tool_calls)', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', reasoning_content: 'only thoughts', content: '' },
    ];

    const { payload: cleaned } = cleanOpenAiMessages(messages);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].role).toBe('user');
  });

  test('keeps assistant message with tool_calls even when content empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'x' } }],
        reasoning_content: 'thoughts',
      },
    ];

    const { payload: cleaned } = cleanOpenAiMessages(messages);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].tool_calls).toHaveLength(1);
  });

  test('does not touch user/system messages', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ];

    const { payload: cleaned, stats } = cleanOpenAiMessages(messages);

    expect(cleaned).toEqual(messages);
    expect(stats.cleanedBlocks).toBe(0);
  });
});

describe('cleanResponsesInput', () => {
  test('removes reasoning items, keeps function_call/output pairs', () => {
    const input = [
      { type: 'message', role: 'user', content: 'q' },
      { type: 'reasoning', id: 'r1', summary: 'thinking', encrypted_content: 'enc' },
      { type: 'function_call', call_id: 'fc1', name: 'search' },
      { type: 'function_call_output', call_id: 'fc1', output: 'ok' },
      { type: 'message', role: 'assistant', content: 'answer' },
    ];

    const { payload: cleaned, stats } = cleanResponsesInput(input);

    expect(cleaned.some((i: any) => i.type === 'reasoning')).toBe(false);
    expect(cleaned.some((i: any) => i.type === 'function_call')).toBe(true);
    expect(cleaned.some((i: any) => i.type === 'function_call_output')).toBe(true);
    expect(stats.cleanedBlocks).toBe(1);
  });

  test('no-op when no reasoning items', () => {
    const input = [{ type: 'message', role: 'user', content: 'q' }];
    const { payload: cleaned, stats } = cleanResponsesInput(input);
    expect(cleaned).toHaveLength(1);
    expect(stats.cleanedBlocks).toBe(0);
  });
});

describe('cleanAnthropicMessages', () => {
  test('removes thinking and redacted_thinking blocks from assistant content', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought', signature: 'sig' },
          { type: 'redacted_thinking', data: 'redacted' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];

    const { payload: cleaned, stats } = cleanAnthropicMessages(messages);

    expect(cleaned[1].content).toHaveLength(1);
    expect(cleaned[1].content[0].type).toBe('text');
    expect(stats.cleanedBlocks).toBe(2);
  });

  test('deletes assistant message when only thinking blocks remained', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'only', signature: 'sig' }],
      },
      { role: 'user', content: 'again' },
    ];

    const { payload: cleaned } = cleanAnthropicMessages(messages);

    expect(cleaned.some((m: any) => m.role === 'assistant')).toBe(false);
  });

  test('keeps assistant message with tool_use block after cleaning', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 's' },
          { type: 'tool_use', id: 'tu1', name: 'search', input: {} },
        ],
      },
    ];

    const { payload: cleaned } = cleanAnthropicMessages(messages);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].content[0].type).toBe('tool_use');
  });

  test('handles string content (no blocks to clean)', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answer' },
    ];

    const { payload: cleaned, stats } = cleanAnthropicMessages(messages);

    expect(cleaned).toEqual(messages);
    expect(stats.cleanedBlocks).toBe(0);
  });
});

describe('cleanGeminiContents', () => {
  test('removes thought parts and strips thoughtSignature', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'hi' }] },
      {
        role: 'model',
        parts: [
          { thought: true, text: 'internal reasoning' },
          { text: 'answer', thoughtSignature: 'sig123' },
          { functionCall: { name: 'search', args: {} }, thoughtSignature: 'sig456' },
        ],
      },
    ];

    const { payload: cleaned, stats } = cleanGeminiContents(contents);

    expect(cleaned[1].parts).toHaveLength(2);
    expect(cleaned[1].parts.some((p: any) => p.thought)).toBe(false);
    expect(cleaned[1].parts.every((p: any) => p.thoughtSignature === undefined)).toBe(true);
    expect(stats.cleanedBlocks).toBeGreaterThanOrEqual(1);
  });

  test('deletes model content when only thought parts remained', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ thought: true, text: 'only thoughts' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ];

    const { payload: cleaned } = cleanGeminiContents(contents);

    expect(cleaned.some((c: any) => c.role === 'model')).toBe(false);
  });

  test('keeps user parts untouched', () => {
    const contents = [{ role: 'user', parts: [{ text: 'hi' }] }];
    const { payload: cleaned, stats } = cleanGeminiContents(contents);
    expect(cleaned).toEqual(contents);
    expect(stats.cleanedBlocks).toBe(0);
  });

  test('does not strip thought flags from user-role parts', () => {
    const contents = [
      { role: 'user', parts: [{ thought: true, text: 'user note', thoughtSignature: 'keep' }] },
    ];
    const { payload: cleaned, stats } = cleanGeminiContents(contents);
    expect(cleaned[0].parts[0].thought).toBe(true);
    expect(cleaned[0].parts[0].thoughtSignature).toBe('keep');
    expect(stats.cleanedBlocks).toBe(0);
  });
});
