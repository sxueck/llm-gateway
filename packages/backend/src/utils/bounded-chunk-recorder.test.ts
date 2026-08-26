import { describe, expect, it } from 'vitest';
import { BoundedChunkRecorder } from './bounded-chunk-recorder.js';

describe('BoundedChunkRecorder', () => {
  it('records chunks under the budget', () => {
    const recorder = new BoundedChunkRecorder(100);
    recorder.record('data: a\n\n');
    recorder.record('data: b\n\n');

    expect(recorder.chunks).toEqual(['data: a\n\n', 'data: b\n\n']);
    expect(recorder.isTruncated).toBe(false);
    expect(recorder.droppedChars).toBe(0);
  });

  it('stops recording once the budget is exhausted and tracks drops', () => {
    const recorder = new BoundedChunkRecorder(10);
    recorder.record('12345'); // 5 chars, under budget
    recorder.record('67890'); // reaches exactly 10 → truncated
    expect(recorder.isTruncated).toBe(true);

    recorder.record('abcdef');
    expect(recorder.droppedChars).toBe(6);
    // Recorded prefix must remain stable after truncation.
    expect(recorder.chunks).toEqual(['12345', '67890']);
  });

  it('keeps a single oversized chunk that arrives before the budget trips', () => {
    // Overshoot past the budget is bounded by one frame: the chunk that
    // crosses the line is kept, everything after is dropped.
    const recorder = new BoundedChunkRecorder(10);
    recorder.record('x'.repeat(50));
    recorder.record('y'.repeat(50));

    expect(recorder.chunks.length).toBe(1);
    expect(recorder.droppedChars).toBe(50);
  });
});
