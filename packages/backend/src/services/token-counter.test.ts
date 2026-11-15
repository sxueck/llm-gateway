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

describe('Responses stream usage', () => {
  it('counts delivered text once and falls back to recorded deltas when absent', async () => {
    const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
    const chunks = [
      frame({ type: 'response.output_text.delta', delta: 'one ' }),
      frame({ type: 'response.output_text.delta', delta: { text: 'two' } }),
      frame({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'one two' }] }] } }),
    ];
    const request = { input: 'quota probe input' };
    for (const delivered of ['one two', undefined, '']) {
      const result = await countStreamResponseTokens(request, chunks, delivered);
      expect(result.completionTokens).toBe(countTokensForText('one two'));
      expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);
    }
    const fullText = '断点续传按完整文本计数不过半'.repeat(100);
    const result = await countStreamResponseTokens(request, chunks, fullText);
    expect(result.completionTokens).toBe(countTokensForText(fullText));
    expect(result.promptTokens).toBe(countTokensForText(request.input));
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

/** SSE 帧构造：与网关 serializeChunkToSse 相同的 event+data 形状。 */
function sseFrame(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** 规格形状的文本增量：delta 是裸字符串。 */
function stringDeltaFrame(text: string): string {
  return sseFrame('response.output_text.delta', { delta: text });
}

/** 网关 WS 适配器形状的文本增量：delta 是 {text} 对象。 */
function objectDeltaFrame(text: string): string {
  return sseFrame('response.output_text.delta', { delta: { text } });
}

describe('countStreamResponseTokens (Responses 断点续传诚实估算)', () => {
  const originalInput = [
    { role: 'user', content: [{ type: 'input_text', text: 'e2e responses resume honest estimate prompt' }] },
  ];

  /** 续写成功后网关磁带的典型形状：原始段增量 + 续写段增量 + 合成终态（携带全文）。 */
  function resumedTape(): string[] {
    return [
      sseFrame('response.created', { response: { id: 'resp_1', status: 'in_progress' } }),
      sseFrame('response.output_item.added', {
        item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      }),
      stringDeltaFrame('E2E '), // 原始段（规格裸字符串 delta，断链前已冲刷）
      objectDeltaFrame('responses ok'), // 续写段（包装对象 delta，身份已被重写）
      // 以下都是合成终态：携带的是拼接全文，不是新增量 —— 不得计入。
      sseFrame('response.output_text.done', { text: 'E2E responses ok' }),
      sseFrame('response.content_part.done', { part: { type: 'output_text', text: 'E2E responses ok' } }),
      sseFrame('response.output_item.done', {
        item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'E2E responses ok' }] },
      }),
      sseFrame('response.completed', {
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'E2E responses ok' }] }],
          usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
        },
      }),
      'data: [DONE]\n\n',
    ];
  }

  it('prompt 只计原客户端 input 一次（结构化项，而非续写重发的 prompt）', async () => {
    const result = await countStreamResponseTokens({ input: originalInput }, resumedTape());
    const expectedPrompt = await countResponsesInputCooperatively(originalInput);
    expect(result.promptTokens).toBe(expectedPrompt);
    expect(result.promptTokens).toBeGreaterThan(0);
  });

  it('字符串 input（非数组）同样计一次 prompt', async () => {
    const result = await countStreamResponseTokens({ input: 'plain string prompt' }, [
      stringDeltaFrame('ok'),
      'data: [DONE]\n\n',
    ]);
    expect(result.promptTokens).toBe(await countResponsesInputCooperatively('plain string prompt'));
    expect(result.promptTokens).toBeGreaterThan(0);
  });

  it('裸字符串 delta 与对象 delta 都计 completion，各一次', async () => {
    const result = await countStreamResponseTokens({ input: originalInput }, [
      stringDeltaFrame('alpha '),
      objectDeltaFrame('beta'),
      'data: [DONE]\n\n',
    ]);
    expect(result.completionTokens).toBe(countTokensForText('alpha beta'));
  });

  it('不重复计合成终态：done/completed/failed 携带的全文不计入 completion', async () => {
    const result = await countStreamResponseTokens({ input: originalInput }, resumedTape());
    // 只有真实增量 "E2E " + "responses ok" 计一次；若终态全文也被计入，
    // 结果会接近两倍。
    expect(result.completionTokens).toBe(countTokensForText('E2E responses ok'));
    expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);
  });

  it('合成失败终态（response.failed 携带全文）同样不计入 completion', async () => {
    const result = await countStreamResponseTokens({ input: originalInput }, [
      stringDeltaFrame('E2E '),
      objectDeltaFrame('doomed tail'),
      sseFrame('response.failed', {
        response: {
          id: 'resp_1',
          status: 'failed',
          error: { code: 'server_error', message: 'upstream exploded' },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'E2E doomed tail' }] }],
        },
      }),
    ]);
    expect(result.completionTokens).toBe(countTokensForText('E2E doomed tail'));
  });

  it('磁带只含终态帧时 completion 为 0（没有可计的增量）', async () => {
    const result = await countStreamResponseTokens(
      { input: originalInput },
      [sseFrame('response.completed', { response: { output: [], status: 'completed' } })],
    );
    expect(result.completionTokens).toBe(0);
    expect(result.promptTokens).toBeGreaterThan(0);
  });
});

describe('countRequestTokens (Responses input 诚实口径)', () => {
  it('结构化 input 项按 Responses 语义计数，而非 "[object Object]" 拼接', async () => {
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'read the document and summarize the key risks' }] },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"docs/big.md"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'the document says: ship it' },
    ];
    const result = await countRequestTokens({ input });
    expect(result.promptTokens).toBe(await countResponsesInputCooperatively(input));
    // 三项载荷都入账，远大于旧实现 join(' ') 得到的 ~3 个 token。
    expect(result.promptTokens).toBeGreaterThan(countTokensForText('summarize the key risks'));
  });

  it('embeddings 纯字符串数组维持拼接文本计数', async () => {
    const result = await countRequestTokens({ input: ['hello gateway', 'stream resume'] });
    expect(result.promptTokens).toBe(countTokensForText('hello gateway stream resume'));
  });

  it('空/无效 input 仍为 0', async () => {
    expect((await countRequestTokens({ input: '' })).promptTokens).toBe(0);
    expect((await countRequestTokens({ input: null })).promptTokens).toBe(0);
    expect((await countRequestTokens({})).promptTokens).toBe(0);
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
