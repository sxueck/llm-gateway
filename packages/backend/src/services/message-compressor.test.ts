import { describe, expect, it } from 'vitest';
import { MessageCompressor } from './message-compressor.js';
import { countTokensForMessages } from './token-counter.js';

function buildLongHistory(): any[] {
  // The compressor only fingerprints fenced code blocks / known XML wrappers
  // (extractTextBlocks ignores plain prose), so deduplication here is driven by
  // byte-identical code fences repeated across history turns.
  const snippet = Array.from(
    { length: 14 },
    (_, n) => `const chunk_${n} = await pipe.read(); if (!chunk_${n} || chunk_${n}.done) return;`
  ).join('\n');
  const fenced = `\n\`\`\`js\n${snippet}\n\`\`\`\n`;
  const messages: any[] = [
    { role: 'system', content: 'You are a helpful LLM gateway assistant.' },
  ];
  for (let i = 0; i < 8; i++) {
    // Same fenced block everywhere; varying prose around it proves matching
    // works per-block rather than per-message.
    messages.push({ role: 'user', content: `Turn ${i}: resend the streaming loop:\n${fenced}` });
    messages.push({
      role: 'assistant',
      content:
        `Answer ${i}: backpressure matters because slow clients stall upstream reads while buffers fill. `
          .repeat(6),
    });
  }
  return messages;
}

describe('MessageCompressor.compressMessages', () => {
  it('counts original tokens consistently with the synchronous encoder', async () => {
    const compressor = new MessageCompressor();
    const messages = buildLongHistory();
    const reference = countTokensForMessages(messages);
    expect(reference).toBeGreaterThan(0);

    const { stats, timing } = await compressor.compressMessages(messages);

    expect(timing.preprocessMs).toBeGreaterThanOrEqual(0);
    expect(timing.tokenCountMs).toBeGreaterThanOrEqual(0);
    expect(timing.totalMs).toBeGreaterThanOrEqual(timing.preprocessMs);
    // Segmented cooperative encoding may shift a handful of BPE boundary
    // merges vs the one-shot pass; allow <1% drift.
    const drift = Math.abs(stats.originalTokenEstimate - reference) / reference;
    expect(drift).toBeLessThan(0.01);
    expect(stats.compressedTokenEstimate).toBeGreaterThan(0);
  });
  it('deduplicates repeated content blocks across history', async () => {
    const compressor = new MessageCompressor();
    const messages = buildLongHistory();

    const { messages: compressed, stats } = await compressor.compressMessages(messages);

    expect(stats.duplicatesFound).toBeGreaterThan(0);
    expect(compressed.length).toBeLessThanOrEqual(messages.length);
    expect(compressed[0]?.role).toBe('system');
    expect(stats.compressionRatio).toBeGreaterThan(0);
    expect(stats.compressionRatio).toBeLessThanOrEqual(1);
  });

  it('short histories bypass compression with empty stats', async () => {
    const compressor = new MessageCompressor();
    const messages = [
      { role: 'system', content: 'tiny' },
      { role: 'user', content: 'hi' },
    ];

    const { messages: compressed, stats } = await compressor.compressMessages(messages);

    expect(compressed).toBe(messages);
    expect(stats.originalTokenEstimate).toBe(0);
    expect(stats.duplicatesFound).toBe(0);
  });
});
