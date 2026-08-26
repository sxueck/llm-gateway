/**
 * Bounds heap growth from recorded SSE stream chunks.
 *
 * Recorded chunks feed three consumers: degraded-mode token fallback, response
 * body logging, and the debug WS replay. None of them justify unbounded
 * buffering of very long streams — heap bloat causes GC pauses that stall
 * every concurrent stream on the event loop. Once the budget is exhausted,
 * recording stops; downstream consumers see a prefix (token fallback then
 * under-counts completion tokens, which is acceptable because upstream usage
 * is preferred whenever available).
 *
 * Overshoot past the budget is bounded by a single SSE frame (typically a few
 * KB) since the check runs between frames.
 */
export const DEFAULT_MAX_RECORDED_CHUNK_CHARS = 256 * 1024;

export class BoundedChunkRecorder {
  private readonly recorded: string[] = [];
  private storedChars = 0;
  private droppedTotal = 0;
  private overBudget = false;

  constructor(private readonly maxChars: number = DEFAULT_MAX_RECORDED_CHUNK_CHARS) {}

  record(chunk: string): void {
    if (this.overBudget) {
      this.droppedTotal += chunk.length;
      return;
    }
    this.recorded.push(chunk);
    this.storedChars += chunk.length;
    if (this.storedChars >= this.maxChars) {
      this.overBudget = true;
    }
  }

  get chunks(): string[] {
    return this.recorded;
  }

  get isTruncated(): boolean {
    return this.overBudget;
  }

  get droppedChars(): number {
    return this.droppedTotal;
  }
}
