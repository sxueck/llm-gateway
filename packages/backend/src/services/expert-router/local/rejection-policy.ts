// v3 routing/rejection policy engine for the local ONNX intent classifier.
//
// Mirrors the model repository's `rejection_policy.json` semantics:
//   1. keyword hard-routing — high-precision regex overrides (bypass rejection)
//   2. top-2 flip rules — correct historically confused near-neighbor pairs
//   3. confidence rejection — top_score < max_probability or very short text
//      collapses to the fallback intent (out_of_scope)
//
// This module is pure logic and carries no runtime dependencies, so it can be
// unit-tested without the ONNX artifacts.

import type { RankedLabel } from './inference-math.js';

export interface FlipRule {
  top: string;
  second: string;
  max_margin: number;
}

export interface KeywordRule {
  intent: string;
  patterns: string[];
}

export interface RejectionPolicy {
  version: number;
  max_probability: number;
  min_margin: number;
  short_text_max_chars: number;
  fallback_intent: string;
  temperature: number;
  enable_flip_rules: boolean;
  enable_keyword_rules: boolean;
  flip_rules: FlipRule[];
  keyword_rules: KeywordRule[];
}

export interface PolicyResult {
  /** Final label after keyword override, flip, or rejection. */
  chosenLabel: string;
  /** True when confidence/short-text rejection fired (chosenLabel == fallback_intent). */
  rejected: boolean;
  rejectionReason?: 'low_confidence' | 'short_text';
  top1: RankedLabel;
  top2: RankedLabel;
  matchedKeywordIntent?: string;
  appliedFlip?: { from: string; to: string; margin: number };
}

export function applyRejectionPolicy(
  text: string,
  ranked: RankedLabel[],
  policy: RejectionPolicy
): PolicyResult {
  const top1 = ranked[0];
  const top2 = ranked[1];
  if (!top1) {
    return {
      chosenLabel: policy.fallback_intent,
      rejected: true,
      rejectionReason: 'low_confidence',
      top1: { label: policy.fallback_intent, score: 0 },
      top2: { label: policy.fallback_intent, score: 0 },
    };
  }

  // 1. Keyword hard-routing (precision-first; bypasses confidence rejection).
  if (policy.enable_keyword_rules) {
    const matched = matchKeywordRule(text, policy.keyword_rules);
    if (matched) {
      return {
        chosenLabel: matched,
        rejected: false,
        top1,
        top2: top2 ?? { label: policy.fallback_intent, score: 0 },
        matchedKeywordIntent: matched,
      };
    }
  }

  // 2. Top-2 flip rules for confused near-neighbor pairs.
  let chosenLabel = top1.label;
  let appliedFlip: PolicyResult['appliedFlip'] | undefined;
  if (policy.enable_flip_rules && top2) {
    const margin = top1.score - top2.score;
    for (const rule of policy.flip_rules) {
      if (top1.label === rule.top && top2.label === rule.second && margin <= rule.max_margin) {
        chosenLabel = rule.second;
        appliedFlip = { from: rule.top, to: rule.second, margin };
        break;
      }
    }
  }

  // 3. Confidence / short-text rejection.
  const isShortText = text != null && text.length <= policy.short_text_max_chars;
  if (top1.score < policy.max_probability) {
    return {
      chosenLabel: policy.fallback_intent,
      rejected: true,
      rejectionReason: 'low_confidence',
      top1,
      top2: top2 ?? { label: policy.fallback_intent, score: 0 },
      matchedKeywordIntent: undefined,
      appliedFlip,
    };
  }
  if (isShortText) {
    return {
      chosenLabel: policy.fallback_intent,
      rejected: true,
      rejectionReason: 'short_text',
      top1,
      top2: top2 ?? { label: policy.fallback_intent, score: 0 },
      matchedKeywordIntent: undefined,
      appliedFlip,
    };
  }

  return {
    chosenLabel,
    rejected: false,
    top1,
    top2: top2 ?? { label: policy.fallback_intent, score: 0 },
    matchedKeywordIntent: undefined,
    appliedFlip,
  };
}

function matchKeywordRule(text: string, rules: KeywordRule[]): string | undefined {
  if (!text) return undefined;
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      try {
        if (new RegExp(pattern, 'i').test(text)) {
          return rule.intent;
        }
      } catch {
        // Skip malformed patterns rather than failing classification.
      }
    }
  }
  return undefined;
}
