import { createHash } from 'node:crypto';

export type NormalizationProtocol = 'openai' | 'anthropic' | 'gemini';

/** Sentinel used when no reasoning configuration is supplied (FR-3). */
export const REASONING_NONE = 'none';

export interface ContextFingerprintInput {
  protocol: NormalizationProtocol;
  providerId: string;
  /** Final value of `body.model` after model-suffix resolution. */
  model: string;
  body: any;
  /** Forced reasoning effort resolved from model-name suffix (OpenAI only). */
  forcedReasoningEffort?: string;
}

export interface FingerprintComponents {
  protocol: NormalizationProtocol;
  providerId: string;
  model: string;
  reasoningConfig: unknown;
  toolsFlag: boolean;
}

/**
 * Normalize reasoning configuration per protocol (FR-3). Absence collapses to a
 * fixed sentinel so the fingerprint never carries `undefined`.
 */
export function extractReasoningConfigByProtocol(
  protocol: NormalizationProtocol,
  body: any,
  forcedReasoningEffort?: string
): unknown {
  switch (protocol) {
    case 'openai': {
      const effort =
        body?.reasoning_effort ?? body?.reasoning?.effort ?? forcedReasoningEffort ?? REASONING_NONE;
      return { effort };
    }
    case 'anthropic': {
      return body?.thinking ?? REASONING_NONE;
    }
    case 'gemini': {
      return body?.generationConfig?.thinkingConfig ?? REASONING_NONE;
    }
    default:
      return REASONING_NONE;
  }
}

/**
 * Binary flag: whether the protocol's tool declarations are present (FR-4).
 */
export function extractToolsFlag(protocol: NormalizationProtocol, body: any): boolean {
  if (!body) return false;
  if (protocol === 'gemini') {
    const tools = body.tools;
    if (!Array.isArray(tools)) return false;
    return tools.some((t) => t && Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0);
  }
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * Recursively canonicalize a value: arrays mapped element-wise, object keys
 * sorted ascending. This makes the fingerprint robust to client-side key-order
 * noise inside nested reasoning config (NFR-2, AC-10).
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize fingerprint components with a fixed top-level field order
 * (`protocol, providerId, model, reasoningConfig, toolsFlag`) per the shared
 * fingerprint JSON contract. Nested values are canonicalized for determinism.
 */
export function serializeFingerprintComponents(components: FingerprintComponents): string {
  const ordered = {
    protocol: components.protocol,
    providerId: components.providerId,
    model: components.model,
    reasoningConfig: canonicalValue(components.reasoningConfig),
    toolsFlag: components.toolsFlag,
  };
  return JSON.stringify(ordered);
}

export function buildFingerprintComponents(input: ContextFingerprintInput): FingerprintComponents {
  return {
    protocol: input.protocol,
    providerId: input.providerId,
    model: input.model ?? '',
    reasoningConfig: extractReasoningConfigByProtocol(input.protocol, input.body, input.forcedReasoningEffort),
    toolsFlag: extractToolsFlag(input.protocol, input.body),
  };
}

/**
 * Deterministic context fingerprint: sha256 over the canonical, fixed-order
 * serialization of the fingerprint components (FR-1, R-604).
 */
export function computeContextFingerprint(input: ContextFingerprintInput): string {
  const serialized = serializeFingerprintComponents(buildFingerprintComponents(input));
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
