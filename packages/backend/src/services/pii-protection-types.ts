/**
 * PII Protection - Types and Context
 *
 * Request-level context for PII detection, masking, and restoration.
 * All operations are synchronous and lightweight for performance.
 */

export type PiiType = 'secret' | 'ip' | 'email';

export interface PiiDetection {
  type: PiiType;
  original: string;
  masked: string;
  position: number;
}

export interface PiiProtectionContext {
  enabled: boolean;
  /** original -> masked mapping for request processing */
  replacements: Map<string, string>;
  /** masked -> original mapping for response restoration */
  reverseReplacements: Map<string, string>;
  /** Detection records for debugging/auditing */
  detections: PiiDetection[];
  /** Counter for generating unique masked values */
  counter: number;
}

export interface PiiMaskingOptions {
  /** Enable secret detection (API keys, tokens, etc.) */
  detectSecrets?: boolean;
  /** Enable IP address detection */
  detectIps?: boolean;
  /** Enable email detection */
  detectEmails?: boolean;
}

export const DEFAULT_MASKING_OPTIONS: Required<PiiMaskingOptions> = {
  detectSecrets: true,
  detectIps: true,
  detectEmails: true,
};

/**
 * Create a new request-scoped PII protection context
 */
export function createPiiProtectionContext(
  enabled: boolean,
  _options?: PiiMaskingOptions
): PiiProtectionContext {
  return {
    enabled,
    replacements: new Map(),
    reverseReplacements: new Map(),
    detections: [],
    counter: 0,
  };
}

/**
 * Reset context for reuse (mainly for testing)
 */
export function resetPiiProtectionContext(ctx: PiiProtectionContext): void {
  ctx.replacements.clear();
  ctx.reverseReplacements.clear();
  ctx.detections.length = 0;
  ctx.counter = 0;
}
