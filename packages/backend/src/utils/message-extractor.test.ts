import { describe, expect, test } from 'vitest';
import {
  extractTextFromContent,
  extractUserMessagesForClassification,
  extractResponsesInputForClassification,
} from './message-extractor.js';

describe('extractTextFromContent', () => {
  test('returns string content as-is', () => {
    expect(extractTextFromContent('hello world')).toBe('hello world');
  });

  test('returns empty for null/undefined', () => {
    expect(extractTextFromContent(null as any)).toBe('');
    expect(extractTextFromContent(undefined as any)).toBe('');
  });

  test('extracts text blocks from OpenAI content array', () => {
    expect(
      extractTextFromContent([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ])
    ).toBe('first\nsecond');
  });

  test('extracts input_text blocks from Responses-style arrays', () => {
    expect(
      extractTextFromContent([
        { type: 'input_text', text: 'hello' },
        { type: 'input_image', image_url: { url: 'https://example.com' } },
      ])
    ).toBe('hello');
  });

  test('extracts content field when text is missing', () => {
    expect(
      extractTextFromContent([
        { type: 'text', content: 'uses content field' },
        { type: 'custom', content: 'another content' },
      ])
    ).toBe('uses content field\nanother content');
  });

  test('extracts text from single content block object', () => {
    expect(extractTextFromContent({ type: 'text', text: 'single block' })).toBe('single block');
  });

  test('falls back to JSON for non-text object when strip_files is disabled', () => {
    const obj = { type: 'image_url', image_url: { url: 'https://example.com' } };
    expect(extractTextFromContent(obj)).toContain('image_url');
  });

  test('returns empty for non-text object when strip_files is enabled', () => {
    const obj = { type: 'image_url', image_url: { url: 'https://example.com' } };
    expect(extractTextFromContent(obj, { strip_files: true })).toBe('');
  });

  test('ignores image blocks in arrays', () => {
    expect(
      extractTextFromContent([
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'https://example.com' } },
      ])
    ).toBe('describe');
  });
});

describe('extractUserMessagesForClassification', () => {
  test('extracts last user message and ignores system', () => {
    const result = extractUserMessagesForClassification([
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'follow up' },
    ]);

    expect(result.lastUserMessage).toBe('follow up');
    expect(result.systemPrompt).toBe('sys prompt');
    expect(result.conversationHistory).toContain('[1] User: first question');
    expect(result.conversationHistory).toContain('[2] Assistant: answer');
  });

  test('throws when no user message exists', () => {
    expect(() =>
      extractUserMessagesForClassification([
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'hi' },
      ])
    ).toThrow('No user message found for classification');
  });

  test('strips system prompt when requested', () => {
    const result = extractUserMessagesForClassification(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
      undefined,
      { strip_system_prompt: true }
    );

    expect(result.systemPrompt).toBeUndefined();
  });

  test('extracts user text from content array with input_text type', () => {
    const result = extractUserMessagesForClassification([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'what is this?' }],
      },
    ]);

    expect(result.lastUserMessage).toBe('what is this?');
  });

  test('extracts user text from content array with content field', () => {
    const result = extractUserMessagesForClassification([
      {
        role: 'user',
        content: [{ type: 'text', content: 'uses content field' }],
      },
    ]);

    expect(result.lastUserMessage).toBe('uses content field');
  });
});

describe('extractResponsesInputForClassification', () => {
  test('extracts text from role-less input_text items', () => {
    const result = extractResponsesInputForClassification([
      { type: 'input_text', text: 'hello' },
    ]);

    expect(result.lastUserMessage).toBe('hello');
  });

  test('extracts last user message from roleful items', () => {
    const result = extractResponsesInputForClassification([
      { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: [{ type: 'input_text', text: 'second' }] },
    ]);

    expect(result.lastUserMessage).toBe('second');
  });

  test('ignores system messages when strip_system_prompt is true', () => {
    const result = extractResponsesInputForClassification(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      { strip_system_prompt: true }
    );

    expect(result.systemPrompt).toBeUndefined();
    expect(result.lastUserMessage).toBe('hello');
  });
});
