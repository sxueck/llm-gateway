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
        // Only process text blocks, exclude tool_result and other structured blocks
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

  // Build masked text from end to start to maintain positions
  let result = text;
  for (let i = detections.length - 1; i >= 0; i--) {
    const det = detections[i];
    const masked = getOrCreateMaskedValue(ctx, det.value, det.type);
    result = result.slice(0, det.start) + masked + result.slice(det.end);
  }

  return result;
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
    let result = text;

    // Replace all masked values with originals
    for (const [masked, original] of ctx.reverseReplacements) {
      result = result.split(masked).join(original);
    }

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
 */
export class PiiStreamRestorer {
  private pendingByKey = new Map<string, string>();
  private readonly ctx: PiiProtectionContext;
  private readonly maxMaskedValueLen: number;

  constructor(ctx: PiiProtectionContext) {
    this.ctx = ctx;
    // Calculate max masked value length for buffer sizing
    this.maxMaskedValueLen = Math.max(
      ...Array.from(ctx.reverseReplacements.keys()).map(k => k.length),
      1
    );
  }

  /**
   * Process a text fragment, restoring any masked values
   * Returns the processed text (with original values restored where possible)
   */
  process(key: string, fragment: string): string {
    if (!fragment) return fragment;

    const pending = this.pendingByKey.get(key) || '';
    let combined = pending + fragment;

    // Try to restore in the combined buffer
    combined = this.restoreInText(combined);

    // Compute how much we can safely output
    const { toProcess, nextPending } = this.computeSafeSplit(combined);
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
   */
  private restoreInText(text: string): string {
    let result = text;
    for (const [masked, original] of this.ctx.reverseReplacements) {
      result = result.split(masked).join(original);
    }
    return result;
  }
}

// Export singleton service
export const piiProtectionService = {
  maskRequestBodyInPlace,
  restoreResponseBodyInPlace,
};
