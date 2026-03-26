/**
 * PII Protection Service
 *
 * Builtin service for detecting and masking PII in request bodies,
 * and restoring original values in responses.
 *
 * Lightweight, synchronous, in-memory implementation.
 */

import { memoryLogger } from './logger.js';
import {
  PiiProtectionContext,
  createPiiProtectionContext,
  PiiMaskingOptions,
  DEFAULT_MASKING_OPTIONS,
} from './pii-protection-types.js';
import { detectPii, mightContainPii } from './pii-detector.js';
import { getOrCreateMaskedValue } from './pii-mask-generator.js';

export interface PiiProtectionResult {
  /** Whether PII protection was applied */
  applied: boolean;
  /** The protection context (needed for restoration) */
  context: PiiProtectionContext | null;
  /** Number of items masked */
  maskedCount: number;
}

interface TextRef {
  get: () => string;
  set: (value: string) => void;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RESTORATION_REGEX_THRESHOLD = 50;

function getRestorationRegex(ctx: PiiProtectionContext): RegExp | null {
  if (ctx.reverseReplacements.size === 0) {
    ctx.restorationRegex = null;
    ctx.regexCacheBuiltAt = ctx.restorationCacheVersion;
    return null;
  }

  if (ctx.restorationRegex && ctx.regexCacheBuiltAt === ctx.restorationCacheVersion) {
    ctx.restorationRegex.lastIndex = 0;
    return ctx.restorationRegex;
  }

  const alternation = Array.from(ctx.reverseReplacements.keys())
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');

  ctx.restorationRegex = alternation ? new RegExp(alternation, 'g') : null;
  ctx.regexCacheBuiltAt = ctx.restorationCacheVersion;
  return ctx.restorationRegex;
}

function restoreMaskedValues(text: string, ctx: PiiProtectionContext): string {
  if (ctx.reverseReplacements.size === 0) {
    return text;
  }

  // For small mappings, use regex for efficiency
  if (ctx.reverseReplacements.size <= RESTORATION_REGEX_THRESHOLD) {
    const restorationRegex = getRestorationRegex(ctx);
    if (!restorationRegex) {
      return text;
    }
    restorationRegex.lastIndex = 0;
    return text.replace(restorationRegex, (masked) => ctx.reverseReplacements.get(masked) ?? masked);
  }

  // For large mappings, use non-regex scan to avoid expensive regex compilation
  return restoreMaskedValuesNonRegex(text, ctx);
}

function getRestorationSortedKeys(ctx: PiiProtectionContext): string[] {
  if (ctx.restorationSortedKeys && ctx.sortedKeysCacheBuiltAt === ctx.restorationCacheVersion) {
    return ctx.restorationSortedKeys;
  }
  
  ctx.restorationSortedKeys = Array.from(ctx.reverseReplacements.keys())
    .sort((a, b) => b.length - a.length);
  ctx.sortedKeysCacheBuiltAt = ctx.restorationCacheVersion;
  return ctx.restorationSortedKeys;
}

/**
 * Non-regex restoration for large replacement sets
 * Uses simple string scanning with sorted keys (longest first to avoid partial matches)
 */
function restoreMaskedValuesNonRegex(text: string, ctx: PiiProtectionContext): string {
  if (ctx.reverseReplacements.size === 0) {
    return text;
  }

  // Sort keys by length descending to match longest first
  const keys = getRestorationSortedKeys(ctx);
  let result = text;

  for (const key of keys) {
    const original = ctx.reverseReplacements.get(key);
    if (!original) continue;

    // Simple global replace
    let idx = result.indexOf(key);
    while (idx !== -1) {
      result = result.slice(0, idx) + original + result.slice(idx + key.length);
      // Continue searching after the replacement
      idx = result.indexOf(key, idx + original.length);
    }
  }

  return result;
}

/**
 * Collect all text references from a request/response body
 * for built-in PII protection
 */
function collectTextRefs(body: any): TextRef[] {
  const refs: TextRef[] = [];

  const pushStringRef = (getter: () => any, setter: (v: any) => void) => {
    const value = getter();
    if (typeof value !== 'string') return;
    if (!value.trim()) return;
    refs.push({ get: getter, set: setter });
  };

  const walkMessageContent = (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (typeof message.content === 'string') {
      pushStringRef(() => message.content, (v) => { message.content = v; });
      return;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
          pushStringRef(() => part.text, (v) => { part.text = v; });
        }
      }
    }
  };

  // OpenAI chat: messages
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      walkMessageContent(msg);
    }
  }

  // Chat completion response: choices[].message.content
  if (Array.isArray(body?.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== 'object') continue;
      if (choice.message && typeof choice.message === 'object') {
        walkMessageContent(choice.message);
      }
      if (typeof choice.text === 'string') {
        pushStringRef(() => choice.text, (v) => { choice.text = v; });
      }
      if (typeof choice.reasoning_content === 'string') {
        pushStringRef(() => choice.reasoning_content, (v) => { choice.reasoning_content = v; });
      }
    }
  }

  // Prompt field (completions API)
  if (typeof body?.prompt === 'string') {
    pushStringRef(() => body.prompt, (v) => { body.prompt = v; });
  }

  // Input field (embeddings, responses)
  if (typeof body?.input === 'string') {
    pushStringRef(() => body.input, (v) => { body.input = v; });
  } else if (Array.isArray(body?.input)) {
    for (let i = 0; i < body.input.length; i++) {
      if (typeof body.input[i] === 'string') {
        const idx = i;
        pushStringRef(() => body.input[idx], (v) => { body.input[idx] = v; });
      }
    }
  }

  // Instructions field
  if (typeof body?.instructions === 'string') {
    pushStringRef(() => body.instructions, (v) => { body.instructions = v; });
  }

  // Anthropic system field: can be string or content blocks
  if (typeof body?.system === 'string') {
    pushStringRef(() => body.system, (v) => { body.system = v; });
  } else if (Array.isArray(body?.system)) {
    for (const block of body.system) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        pushStringRef(() => block.text, (v) => { block.text = v; });
      }
    }
  }

  // Anthropic response content blocks: text and thinking types
  if (Array.isArray(body?.content)) {
    for (const block of body.content) {
      if (!block || typeof block !== 'object') continue;
      // text blocks
      if (block.type === 'text' && typeof block.text === 'string') {
        pushStringRef(() => block.text, (v) => { block.text = v; });
      }
      // thinking blocks
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        pushStringRef(() => block.thinking, (v) => { block.thinking = v; });
      }
    }
  }

  // OpenAI Responses API non-stream response text shapes
  // Shape 1: Top-level output_text field
  if (typeof body?.output_text === 'string') {
    pushStringRef(() => body.output_text, (v) => { body.output_text = v; });
  }

  // Shape 2 & 3: output array with text fields and nested content blocks
  if (Array.isArray(body?.output)) {
    for (const item of body.output) {
      if (!item || typeof item !== 'object') continue;

      // Shape 2: item.text field
      if (typeof item.text === 'string') {
        pushStringRef(() => item.text, (v) => { item.text = v; });
      }

      // Shape 3: item.content[] blocks with type 'output_text' or 'text'
      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (!block || typeof block !== 'object') continue;
          // Only process text-bearing blocks, not tool calls or other structured data
          if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
            pushStringRef(() => block.text, (v) => { block.text = v; });
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Apply PII masking to text
 * Optimized: uses fragment array with single join() to avoid repeated string copies
 */
function applyMasking(text: string, ctx: PiiProtectionContext): string {
  // Quick check first
  if (!mightContainPii(text)) {
    return text;
  }

  // Detect all PII
  const detections = detectPii(text);
  if (detections.length === 0) {
    return text;
  }

  // Build masked text using fragment array + single join()
  // Process from end to start to maintain positions
  const fragments: string[] = [];
  let lastPos = text.length;

  for (let i = detections.length - 1; i >= 0; i--) {
    const det = detections[i];
    const masked = getOrCreateMaskedValue(ctx, det.value, det.type);

    // Add fragment after current detection (from det.end to lastPos)
    if (det.end < lastPos) {
      fragments.push(text.slice(det.end, lastPos));
    }

    // Add masked value
    fragments.push(masked);
    lastPos = det.start;
  }

  // Add remaining prefix
  if (lastPos > 0) {
    fragments.push(text.slice(0, lastPos));
  }

  // Reverse and join to get final result
  return fragments.reverse().join('');
}

/**
 * Mask PII in request body in place
 *
 * @param body - The request body to mask
 * @param enabled - Whether PII protection is enabled
 * @param options - Optional masking options
 * @returns Result with context for restoration
 */
export function maskRequestBodyInPlace(
  body: any,
  enabled: boolean,
  options?: PiiMaskingOptions
): PiiProtectionResult {
  if (!enabled) {
    return { applied: false, context: null, maskedCount: 0 };
  }

  const mergedOptions = { ...DEFAULT_MASKING_OPTIONS, ...options };
  const refs = collectTextRefs(body);

  if (refs.length === 0) {
    return { applied: false, context: null, maskedCount: 0 };
  }

  const ctx = createPiiProtectionContext(enabled, mergedOptions);
  let maskedCount = 0;

  for (const ref of refs) {
    const original = ref.get();
    const masked = applyMasking(original, ctx);
    if (masked !== original) {
      ref.set(masked);
      maskedCount++;
    }
  }

  if (ctx.detections.length > 0) {
    memoryLogger.debug(
      `PII protection masked ${ctx.detections.length} items in ${maskedCount} fields`,
      'PII'
    );
  }

  return {
    applied: ctx.detections.length > 0,
    context: ctx.detections.length > 0 ? ctx : null,
    maskedCount: ctx.detections.length,
  };
}

/**
 * Restore original values in response body in place
 *
 * @param body - The response body to restore
 * @param ctx - The protection context from masking
 */
export function restoreResponseBodyInPlace(
  body: any,
  ctx: PiiProtectionContext | null
): void {
  if (!ctx || !ctx.enabled || ctx.reverseReplacements.size === 0) {
    return;
  }

  const refs = collectTextRefs(body);
  if (refs.length === 0) return;

  let restoredCount = 0;
  for (const ref of refs) {
    const text = ref.get();
    const result = restoreMaskedValues(text, ctx);

    if (result !== text) {
      ref.set(result);
      restoredCount++;
    }
  }

  if (restoredCount > 0) {
    memoryLogger.debug(
      `PII protection restored ${restoredCount} fields`,
      'PII'
    );
  }
}

/**
 * Stream restorer for SSE responses
 * Handles cross-chunk boundary restoration with bounded buffer
 *
 * Optimizations:
 * - Buffers small fragments to reduce restore frequency
 * - Uses non-regex path for large replacement sets
 */
export class PiiStreamRestorer {
  private pendingByKey = new Map<string, string>();
  private readonly ctx: PiiProtectionContext;
  private readonly maxMaskedValueLen: number;
  private readonly useRegex: boolean;

  // Buffering threshold: accumulate small fragments before restore
  // Based on typical placeholder length (~20-40 chars) + safety margin
  private readonly bufferThreshold: number;

  constructor(ctx: PiiProtectionContext) {
    this.ctx = ctx;
    // Calculate max masked value length for buffer sizing
    this.maxMaskedValueLen = Math.max(
      ...Array.from(ctx.reverseReplacements.keys()).map(k => k.length),
      1
    );
    // Use regex only for small replacement sets
    this.useRegex = ctx.reverseReplacements.size <= RESTORATION_REGEX_THRESHOLD;
    // Set buffer threshold: at least 2x max placeholder length or 64 chars minimum
    this.bufferThreshold = Math.max(this.maxMaskedValueLen * 2, 64);
  }

  /**
   * Process a text fragment, restoring any masked values
   * Returns the processed text (with original values restored where possible)
   *
   * Optimized: accumulates small fragments to reduce restore frequency
   */
  process(key: string, fragment: string): string {
    if (!fragment) return fragment;

    const pending = this.pendingByKey.get(key) || '';
    const combined = pending + fragment;

    // If combined buffer is still small, keep accumulating
    if (combined.length < this.bufferThreshold) {
      this.pendingByKey.set(key, combined);
      return '';
    }

    // Try to restore in the combined buffer
    const restored = this.restoreInText(combined);

    // Compute how much we can safely output
    const { toProcess, nextPending } = this.computeSafeSplit(restored);
    this.pendingByKey.set(key, nextPending);

    return toProcess;
  }

  /**
   * Flush any pending content for a key
   */
  flush(key: string): string {
    const pending = this.pendingByKey.get(key) || '';
    this.pendingByKey.set(key, '');
    return this.restoreInText(pending);
  }

  /**
   * Compute safe split point to avoid breaking masked values
   */
  private computeSafeSplit(buffer: string): { toProcess: string; nextPending: string } {
    if (!buffer) return { toProcess: '', nextPending: '' };

    const keep = Math.min(this.maxMaskedValueLen - 1, buffer.length);
    if (keep <= 0) {
      return { toProcess: buffer, nextPending: '' };
    }

    return {
      toProcess: buffer.slice(0, buffer.length - keep),
      nextPending: buffer.slice(buffer.length - keep),
    };
  }

  /**
   * Restore masked values in text
   * Uses regex for small sets, non-regex scan for large sets
   */
  private restoreInText(text: string): string {
    if (this.ctx.reverseReplacements.size === 0) {
      return text;
    }

    if (this.useRegex) {
      const regex = getRestorationRegex(this.ctx);
      if (!regex) return text;
      regex.lastIndex = 0;
      return text.replace(regex, (masked) => this.ctx.reverseReplacements.get(masked) ?? masked);
    }

    // Non-regex path for large replacement sets
    return restoreMaskedValuesNonRegex(text, this.ctx);
  }
}

// Export singleton service
export const piiProtectionService = {
  maskRequestBodyInPlace,
  restoreResponseBodyInPlace,
};
