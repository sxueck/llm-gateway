import { describe, expect, it } from 'vitest';
import { countRequestTokens, countStreamResponseTokens, countTokensForMessages, countTokensForText } from './token-counter.js';

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
