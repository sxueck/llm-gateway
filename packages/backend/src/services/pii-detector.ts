/**
 * PII Protection - Detector
 *
 * Conservative detection for secrets, IPs, and emails.
 * Prioritizes precision over recall to avoid false positives.
 */

import { PiiType } from './pii-protection-types.js';

export interface DetectedPii {
  type: PiiType;
  value: string;
  start: number;
  end: number;
}

interface PiiMatchCandidate extends DetectedPii {
  priority: number;
}

// Secret patterns - conservative matching
const SECRET_PATTERNS: { name: string; regex: RegExp; type: PiiType }[] = [
  // OpenAI API keys: sk-xxx, sk-proj-xxx, sk-test-xxx, sk-admin-xxx
  {
    name: 'openai_key',
    regex: /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
    type: 'secret',
  },
  // GitHub tokens: ghp_xxx, gho_xxx, ghu_xxx, ghs_xxx, ghr_xxx, github_pat_xxx
  {
    name: 'github_token',
    regex: /\b(?:gh[pousr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})\b/g,
    type: 'secret',
  },
  // Bearer tokens in Authorization header format
  {
    name: 'bearer_token',
    regex: /\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi,
    type: 'secret',
  },
  // JWT: xxx.yyy.zzz format with specific structure
  {
    name: 'jwt',
    regex: /\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b/g,
    type: 'secret',
  },
  // PEM/Private key headers
  {
    name: 'pem_private_key',
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
    type: 'secret',
  },
  // PEM/Private key footers
  {
    name: 'pem_footer',
    regex: /-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
    type: 'secret',
  },
  // API key patterns: api_key=, apikey=, api-key=
  {
    name: 'api_key_param',
    regex: /\b(?:api[_-]?key|apikey)\s*=\s*[a-zA-Z0-9_\-\.]{16,}\b/gi,
    type: 'secret',
  },
  // Generic long token candidates are filtered by conservative heuristics below.
  {
    name: 'high_entropy_token',
    regex: /\b[A-Za-z0-9._-]{24,}\b/g,
    type: 'secret',
  },
];

// IP address patterns
const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;

// IPv6 patterns - simplified for common formats
const IPV6_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
const IPV6_COMPRESSED_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\b/g;

// Email pattern - RFC 5322 simplified
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const QUICK_SECRET_HINT_REGEX = /\b(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|Bearer\s|eyJ)/;
const QUICK_IPV4_HINT_REGEX = /\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\./;

function resetRegex(regex: RegExp): RegExp {
  regex.lastIndex = 0;
  return regex;
}

/**
 * Check if a string looks like a false positive for secrets
 */
function looksLikeFalsePositiveSecret(value: string): boolean {
  // Skip common non-secret patterns
  const falsePositives = [
    /^(https?|ftp):\/\//i,  // URLs without auth
    /^\d{4}-\d{2}-\d{2}/,    // Dates
    /^v\d+\.\d+/,            // Version strings
    /^(true|false|null|undefined)$/i,  // JSON literals
  ];

  for (const fp of falsePositives) {
    if (fp.test(value)) return true;
  }

  // Skip if it's just numbers (likely an ID)
  if (/^\d+$/.test(value)) return true;

  // Skip if too short
  if (value.length < 8) return true;

  // Skip common hashes/IDs that are long but not typically reusable secrets.
  if (/^[a-f0-9]{24,}$/i.test(value)) return true;
  if (/^[A-F0-9]{24,}$/i.test(value)) return true;
  if (/^[a-z0-9]{24,}$/i.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }

  return false;
}

function looksLikeConservativeGenericSecret(value: string): boolean {
  if (value.length < 24) return false;
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (!/[_\-.]/.test(value)) return false;
  if (/^[a-f0-9._-]+$/i.test(value)) return false;
  if (/^[A-Za-z]{24,}$/.test(value)) return false;
  return true;
}

/**
 * Detect all PII in text
 */
export function detectPii(text: string): DetectedPii[] {
  const candidates: PiiMatchCandidate[] = [];

  function addCandidate(type: PiiType, value: string, start: number, end: number, priority: number) {
    candidates.push({ type, value, start, end, priority });
  }

  // Detect secrets
  for (let priority = 0; priority < SECRET_PATTERNS.length; priority++) {
    const pattern = SECRET_PATTERNS[priority];
    const regex = resetRegex(pattern.regex);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      if (pattern.name === 'high_entropy_token' && !looksLikeConservativeGenericSecret(value)) {
        continue;
      }
      if (!looksLikeFalsePositiveSecret(value)) {
        addCandidate(pattern.type, value, match.index, match.index + value.length, priority);
      }
    }
  }

  // Detect IPv4
  let match;
  const ipv4Regex = resetRegex(IPV4_REGEX);
  while ((match = ipv4Regex.exec(text)) !== null) {
    const value = match[0];
    // Skip common false positives like version numbers
    if (!looksLikeVersionNumber(value)) {
      addCandidate('ip', value, match.index, match.index + value.length, SECRET_PATTERNS.length);
    }
  }

  // Detect IPv6
  const ipv6Regex = resetRegex(IPV6_REGEX);
  while ((match = ipv6Regex.exec(text)) !== null) {
    addCandidate('ip', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 1);
  }

  const ipv6CompressedRegex = resetRegex(IPV6_COMPRESSED_REGEX);
  while ((match = ipv6CompressedRegex.exec(text)) !== null) {
    addCandidate('ip', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 2);
  }

  // Detect emails
  const emailRegex = resetRegex(EMAIL_REGEX);
  while ((match = emailRegex.exec(text)) !== null) {
    addCandidate('email', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 3);
  }

  candidates.sort((a, b) => a.priority - b.priority || a.start - b.start || b.end - a.end);

  const accepted: PiiMatchCandidate[] = [];
  for (const candidate of candidates) {
    const overlapsAccepted = accepted.some(
      (existing) => candidate.start < existing.end && candidate.end > existing.start
    );
    if (overlapsAccepted) {
      continue;
    }
    accepted.push(candidate);
  }

  accepted.sort((a, b) => a.start - b.start || b.end - a.end || a.priority - b.priority);

  return accepted.map(({ type, value, start, end }) => ({
    type,
    value,
    start,
    end,
  }));
}

/**
 * Check if an IP-like string is actually a version number (false positive)
 */
function looksLikeVersionNumber(value: string): boolean {
  // Version numbers often look like IPs but are in context like "v1.2.3.4" or "version 1.2.3"
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  // If all parts are small numbers (< 10), it's likely a version
  const nums = parts.map(p => parseInt(p, 10));
  if (nums.every(n => n < 10)) return true;

  return false;
}

/**
 * Quick check if text might contain PII (for early exit)
 */
export function mightContainPii(text: string): boolean {
  if (!text || text.length < 3) return false;

  // Quick heuristics
  if (text.includes('@')) return true; // Possible email
  if (QUICK_SECRET_HINT_REGEX.test(text)) return true;
  if (QUICK_IPV4_HINT_REGEX.test(text)) return true;

  return false;
}
