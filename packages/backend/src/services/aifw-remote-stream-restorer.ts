import { AifwClient } from './aifw-client.js';

// Keep in sync with utils/aifw-placeholders.ts placeholder format.
const PLACEHOLDER_PREFIX = '__PII_';
const PLACEHOLDER_SUFFIX = '__';
const PLACEHOLDER_BODY_MAX_LEN = 160;
const PLACEHOLDER_TOTAL_MAX_LEN = PLACEHOLDER_PREFIX.length + PLACEHOLDER_BODY_MAX_LEN + PLACEHOLDER_SUFFIX.length;

const PLACEHOLDER_START_RE = new RegExp(`${PLACEHOLDER_PREFIX.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`);
const PLACEHOLDER_INDEX_PAD_RE = /__PII_([A-Z0-9_]+)_([0-9]{1,7})__/g;

function pad8(n: string): string {
  if (!/^[0-9]+$/.test(n)) return n;
  return n.padStart(8, '0');
}

function normalizePlaceholderIndices(text: string): string {
  if (!text || typeof text !== 'string') return text;
  // Common model corruption: it strips padding and emits _1__ instead of _00000001__.
  // OneAIFW defaults to 8-digit indices (see docs). Re-pad before remote restore.
  return text.replace(PLACEHOLDER_INDEX_PAD_RE, (_m, type, idx) => `__PII_${type}_${pad8(String(idx))}__`);
}

function computeSafeSplit(buffer: string, maxPlaceholderLen: number): { toProcess: string; pending: string } {
  if (!buffer) return { toProcess: '', pending: '' };

  // Fast path: if there's no marker, keep at most a partial "__PII_" prefix.
  if (!buffer.includes('__')) {
    const keep = Math.min(PLACEHOLDER_PREFIX.length - 1, buffer.length);
    return {
      toProcess: buffer.slice(0, buffer.length - keep),
      pending: buffer.slice(buffer.length - keep),
    };
  }

  // Look for the last start marker within the last maxPlaceholderLen window.
  const windowStart = Math.max(0, buffer.length - (maxPlaceholderLen - 1));
  const window = buffer.slice(windowStart);
  const markerPosInWindow = window.lastIndexOf(PLACEHOLDER_PREFIX);
  if (markerPosInWindow >= 0) {
    const markerPos = windowStart + markerPosInWindow;
    const candidate = buffer.slice(markerPos);

    // If it's already a full placeholder token, don't buffer it.
    if (candidate.endsWith(PLACEHOLDER_SUFFIX) && /^__PII_[A-Z0-9_]{3,160}__$/.test(candidate)) {
      return { toProcess: buffer, pending: '' };
    }

    return {
      toProcess: buffer.slice(0, markerPos),
      pending: buffer.slice(markerPos),
    };
  }

  // Otherwise, just keep a suffix window.
  const keep = Math.min(maxPlaceholderLen - 1, buffer.length);
  return {
    toProcess: buffer.slice(0, buffer.length - keep),
    pending: buffer.slice(buffer.length - keep),
  };
}

export class AifwRemoteStreamRestorer {
  private pendingByKey = new Map<string, string>();
  private readonly client: AifwClient;
  private readonly maskMeta: string;
  private readonly maxPlaceholderLen: number;
  private readonly minRemoteChunkChars: number;

  constructor(client: AifwClient, maskMeta: string, opts?: { minRemoteChunkChars?: number }) {
    this.client = client;
    this.maskMeta = maskMeta;
    this.maxPlaceholderLen = Math.max(PLACEHOLDER_TOTAL_MAX_LEN, 8);
    this.minRemoteChunkChars = Math.max(0, Math.floor(opts?.minRemoteChunkChars ?? 48));
  }

  async process(key: string, fragment: string, opts?: { flush?: boolean }): Promise<string> {
    if (typeof fragment !== 'string' || fragment.length === 0) return fragment;

    const pending = this.pendingByKey.get(key) || '';
    const combined = pending + fragment;
    const { toProcess, pending: nextPending } = computeSafeSplit(combined, this.maxPlaceholderLen);
    this.pendingByKey.set(key, nextPending);

    if (!toProcess) return '';

    // Avoid calling remote restore if we don't see placeholder markers.
    // NOTE: if a placeholder is fully contained in toProcess, it will contain "__PII_".
    if (!PLACEHOLDER_START_RE.test(toProcess)) {
      return toProcess;
    }

    // Debounce tiny fragments to reduce restore QPS.
    if (!opts?.flush && toProcess.length < this.minRemoteChunkChars) {
      // Put it back into pending; wait for more.
      this.pendingByKey.set(key, toProcess + nextPending);
      return '';
    }

    try {
      const normalized = normalizePlaceholderIndices(toProcess);
      return await this.client.restoreText(normalized, this.maskMeta);
    } catch {
      // Fail-open: return masked content rather than breaking the stream.
      return toProcess;
    }
  }

  async flush(key: string): Promise<string> {
    const pending = this.pendingByKey.get(key) || '';
    this.pendingByKey.set(key, '');
    if (!pending) return '';
    if (!pending.includes(PLACEHOLDER_PREFIX)) return pending;
    try {
      const normalized = normalizePlaceholderIndices(pending);
      return await this.client.restoreText(normalized, this.maskMeta);
    } catch {
      return pending;
    }
  }
}
