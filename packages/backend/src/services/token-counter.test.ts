import { describe, expect, it } from 'vitest';
import { countRequestTokens } from './token-counter.js';

describe('countRequestTokens', () => {
  it('counts text in Gemini contents parts', async () => {
    const result = await countRequestTokens({
      contents: [{ role: 'user', parts: [{ text: 'Explain this error' }] }],
    });

    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.promptTokens);
  });
});
