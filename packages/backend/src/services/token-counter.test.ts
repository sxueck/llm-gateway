import { describe, expect, it } from 'vitest';
import {
  countMessagesCooperatively,
  countRequestTokens,
  countResponsesInputCooperatively,
  countStreamResponseTokens,
  countTokensForMessages,
  countTokensForText,
} from './token-counter.js';

describe('countRequestTokens', () => {
  it('counts text in Gemini contents parts', async () => {
    const result = await countRequestTokens({
      contents: [{ role: 'user', parts: [{ text: 'Explain this error' }] }],
    });

    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.promptTokens);
  });

  it('returns identical counts to the synchronous encoder for small chat inputs', async () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Explain event loop backpressure.' },
    ];
    const expected = countTokensForMessages(messages);

    const result = await countRequestTokens({ messages });

    expect(result.promptTokens).toBe(expected);
    expect(result.totalTokens).toBe(result.promptTokens);
  });

  it('keeps prompt counting stable for very long inputs that force segmented encoding', async () => {
    // ~48k chars spans multiple ENCODE_SEGMENT_CHARS segments; the total must
    // stay close to what the one-shot sync encoder produces (segment splits
    // only shift a handful of boundary tokens).
    const longText = 'gateway streaming backpressure '.repeat(3200);
    const oneShot = countTokensForText(longText);

    const result = await countRequestTokens({ input: longText });

    expect(result.promptTokens).toBeGreaterThan(0);
    const drift = Math.abs(result.promptTokens - oneShot) / oneShot;
    expect(drift).toBeLessThan(0.01);
  });

  it('counts completion tokens from stream chunk deltas', async () => {
    const requestBody = { messages: [{ role: 'user', content: 'hi' }] };
    const chunk = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
    const chunks = [chunk('hello '), chunk('world'), 'data: [DONE]\n\n'];

    const result = await countStreamResponseTokens(requestBody, chunks);
    const expected = countTokensForText('hello world');

    expect(result.completionTokens).toBe(expected);
    expect(result.totalTokens).toBeGreaterThan(0);
  });
});

describe('countMessagesCooperatively (Anthropic blocks)', () => {
  it('counts tool_use inputs and tool_result contents, not just text blocks', async () => {
    const toolJson = JSON.stringify({ path: 'src/big/file.ts', content: 'x'.repeat(20_000) });
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write', input: JSON.parse(toolJson) }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'wrote the file' }] },
    ];
    const counted = await import('./token-counter.js').then(m => m.countMessagesCooperatively(messages));
    const syncCounted = countTokensForMessages(messages);
    // 两大内容块都入账：远大于角色/固定开销，且两个计数器一致。
    expect(counted).toBeGreaterThan(countTokensForText(toolJson));
    // 分段编码与整串编码在长串上允许 <0.1% 的 BPE 切分差。
    expect(Math.abs(counted - syncCounted)).toBeLessThan(10);
  });
});

describe('countResponsesInputCooperatively (Responses items)', () => {
  it('counts input/output text, function_call arguments, tool outputs and reasoning text', async () => {
    const longOutput = 'x'.repeat(20_000);
    const longArguments = JSON.stringify({ patch: 'y'.repeat(20_000) });
    const input: any[] = [
      { role: 'developer', content: [{ type: 'input_text', text: 'You are a harness.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'edit the file' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'locate the file first' }] },
      { type: 'function_call', call_id: 'c1', name: 'edit', arguments: longArguments },
      { type: 'function_call_output', call_id: 'c1', output: longOutput },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ];

    const counted = await import('./token-counter.js').then(
      m => m.countResponsesInputCooperatively(input)
    );
    // 两大载荷（参数 + 回包）都入账：远超角色/固定开销，且不低于单串分词。
    expect(counted).toBeGreaterThan(countTokensForText(longOutput));
    expect(counted).toBeGreaterThan(countTokensForText(longArguments));

    const stringWithArgsOnly = await import('./token-counter.js').then(
      m => m.countResponsesInputCooperatively([input[3]])
    );
    expect(stringWithArgsOnly).toBeGreaterThan(countTokensForText(longArguments) - 10);
  });

  it('counts bare string inputs and skips empty payloads', async () => {
    const { countResponsesInputCooperatively } = await import('./token-counter.js');
    expect(await countResponsesInputCooperatively('hello world')).toBe(
      countTokensForText('hello world')
    );
    expect(await countResponsesInputCooperatively('')).toBe(0);
    expect(await countResponsesInputCooperatively([])).toBe(0);
    expect(await countResponsesInputCooperatively(undefined)).toBe(0);
  });
});

describe('Anthropic reasoning and inline file blocks', () => {
  const thinkingText = 'Reasoning about which file to read and why. '.repeat(600);
  const base64Blob = 'A'.repeat(400_000); // ≈300KB 解码字节

  it('counts replayed thinking text toward the forwarded input', async () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingText, signature: 'sig' }] },
      { role: 'user', content: [{ type: 'text', text: 'go on' }] },
    ];
    const counted = await countMessagesCooperatively(messages);
    expect(counted).toBeGreaterThan(countTokensForText(thinkingText) - 10);
    expect(Math.abs(counted - countTokensForMessages(messages))).toBeLessThan(10);
  });

  it('weights inline binary payloads above zero but below the plain-text ratio', async () => {
    const messages = [
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Blob } }],
        }],
      },
      { role: 'user', content: [{ type: 'text', text: 'summarize' }] },
    ];
    const counted = await countMessagesCooperatively(messages);
    // 附件不能再计为 0，也不能按同长度文本计费（否则一个大 PDF 就能伪造拦截）。
    expect(counted).toBeGreaterThan(5_000);
    expect(counted).toBeLessThan(Math.ceil(base64Blob.length / 4));
    expect(Math.abs(counted - countTokensForMessages(messages))).toBeLessThan(10);
  });

  it('counts plain-text document sources with the real tokenizer', async () => {
    const counted = await countMessagesCooperatively([
      { role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: thinkingText } }] },
    ]);
    expect(counted).toBeGreaterThan(countTokensForText(thinkingText) - 10);
  });

  it('counts redacted thinking and Responses inline file_data', async () => {
    const redacted = await countMessagesCooperatively([
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: base64Blob }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ]);
    expect(redacted).toBeGreaterThan(5_000);

    const withData = await countResponsesInputCooperatively([
      { role: 'user', content: [{ type: 'input_file', filename: 'big.pdf', file_data: base64Blob }] },
    ]);
    const nameOnly = await countResponsesInputCooperatively([
      { role: 'user', content: [{ type: 'input_file', filename: 'big.pdf' }] },
    ]);
    expect(withData - nameOnly).toBeGreaterThan(5_000);
  });
});
