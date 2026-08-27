import { describe, expect, it } from 'vitest';
import { MessageCompressor } from './message-compressor.js';
import { countTokensForMessages } from './token-counter.js';

const KEEP_RECENT = 5;

// The compressor only fingerprints fenced code blocks / known XML wrappers
// (extractTextBlocks ignores plain prose), so deduplication here is driven by
// byte-identical code fences repeated across history turns.
function fencedBlock(): string {
  const snippet = Array.from(
    { length: 14 },
    (_, n) => `const chunk_${n} = await pipe.read(); if (!chunk_${n} || chunk_${n}.done) return;`
  ).join('\n');
  return `\n\`\`\`js\n${snippet}\n\`\`\`\n`;
}

function buildLongHistory(): any[] {
  const fenced = fencedBlock();
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

function textOf(msg: any): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p: any) => p && p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
  }
  return '';
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

  it('keeps the first occurrence and points later duplicates at it', async () => {
    const compressor = new MessageCompressor();
    const messages = buildLongHistory();

    const { messages: compressed } = await compressor.compressMessages(messages);

    // history = 0..11, user turns at 1/3/5/7/9/11; first occurrence at #2 (1-based)
    expect(textOf(compressed[1])).toContain('const chunk_0');
    for (const idx of [3, 5, 7, 9, 11]) {
      expect(textOf(compressed[idx])).toContain('[... #2]');
      expect(textOf(compressed[idx])).not.toContain('const chunk_0');
    }
  });

  it('produces a byte-stable compressed prefix as the conversation grows', async () => {
    const compressor = new MessageCompressor();
    const turn1 = buildLongHistory();
    const r1 = await compressor.compressMessages(turn1);
    const historyLen1 = turn1.length - KEEP_RECENT;

    // 新一轮对话：重复块再次出现 + 普通追加（旧实现会把所有引用改指向最新出现）
    const turn2 = [
      ...turn1,
      { role: 'user', content: `resend again:\n${fencedBlock()}` },
      { role: 'assistant', content: 'acknowledged.'.repeat(20) },
    ];
    const r2 = await compressor.compressMessages(turn2);

    // 已压缩历史的输出必须逐字节稳定，上游前缀缓存才不会被逐轮破坏
    expect(r2.messages.slice(0, historyLen1)).toEqual(r1.messages.slice(0, historyLen1));
    // 老历史中的引用仍指向首次出现 #2
    expect(
      r2.messages.slice(0, historyLen1).some(m => textOf(m).includes('[... #2]'))
    ).toBe(true);
    // 新进入历史的重复块也引用 #2，而不是指向最新的出现位置
    const agedIn = r2.messages[historyLen1];
    if (textOf(agedIn).includes('[... #')) {
      expect(textOf(agedIn)).toContain('[... #2]');
    }
  });

  it('reuses cached history incrementally and keeps stats exact', async () => {
    const compressor = new MessageCompressor();
    const turn1 = buildLongHistory();
    const r1 = await compressor.compressMessages(turn1);
    expect(r1.cache.hit).toBe(false);

    const turn2 = [
      ...turn1,
      { role: 'user', content: 'next turn' },
      { role: 'assistant', content: 'ok'.repeat(40) },
    ];
    const r2 = await compressor.compressMessages(turn2);

    expect(r2.cache.hit).toBe(true);
    expect(r2.cache.reusedMessages).toBe(turn1.length - KEEP_RECENT);

    // 增量统计与全量重算一致（<1% 分段 BPE 漂移）
    const reference = countTokensForMessages(turn2);
    const drift = Math.abs(r2.stats.originalTokenEstimate - reference) / reference;
    expect(drift).toBeLessThan(0.01);
    expect(r2.stats.duplicatesFound).toBeGreaterThan(0);
    expect(r2.stats.compressedMessageCount).toBe(turn2.length);
  });

  it('falls back to a full recompute when the history prefix is edited', async () => {
    const compressor = new MessageCompressor();
    const turn1 = buildLongHistory();
    await compressor.compressMessages(turn1);

    const edited = [...turn1];
    edited[5] = { role: 'user', content: `edited turn:\n${fencedBlock()}` };

    const r = await compressor.compressMessages(edited);
    expect(r.cache.hit).toBe(false);
    expect(r.messages.length).toBe(edited.length);
  });

  it('does not replace duplicate text parts within the same message', async () => {
    const compressor = new MessageCompressor();
    const fenced = fencedBlock();
    const messages: any[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `first part:\n${fenced}` },
          { type: 'text', text: `same message duplicate:\n${fenced}` },
        ],
      },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `filler ${i}` })),
    ];

    const { messages: compressed } = await compressor.compressMessages(messages);
    const parts = compressed[1].content;

    expect(parts[0].text).toContain('const chunk_0');
    expect(parts[1].text).toContain('const chunk_0');
    expect(parts[0].text).not.toContain('[... #2]');
    expect(parts[1].text).not.toContain('[... #2]');
  });

  it('preserves array content structure and non-text parts', async () => {
    const compressor = new MessageCompressor();
    const fenced = fencedBlock();
    const messages: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `first copy:\n${fenced}` },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `second copy:\n${fenced}` },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: 'tail remark' },
        ],
      },
    ];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `filler ${i}` });
    }

    const { messages: compressed } = await compressor.compressMessages(messages);

    // 首次出现（字符串 content）保留完整代码
    expect(compressed[1].content).toContain('const chunk_0');

    // 数组 content：结构、图片 part、非替换文本 part 全部保留，文本 part 被替换
    const arr = compressed[2].content;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(3);
    expect(arr[1].type).toBe('image_url');
    expect(arr[1].image_url.url).toBe('data:image/png;base64,AAAA');
    expect(arr[0].type).toBe('text');
    expect(arr[0].text).toContain('[... #2]');
    expect(arr[0].text).not.toContain('const chunk_0');
    expect(arr[2].text).toBe('tail remark');
  });

  it('short histories bypass compression with empty stats', async () => {
    const compressor = new MessageCompressor();
    const messages = [
      { role: 'system', content: 'tiny' },
      { role: 'user', content: 'hi' },
    ];

    const { messages: compressed, stats, cache } = await compressor.compressMessages(messages);

    expect(compressed).toBe(messages);
    expect(stats.originalTokenEstimate).toBe(0);
    expect(stats.duplicatesFound).toBe(0);
    expect(cache.hit).toBe(false);
  });
});
