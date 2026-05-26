import { createHash } from 'crypto';
import { PiiType } from './pii-protection-types.js';
import { LRUCache } from '../utils/lru-cache.js';

export interface DetectedPii {
  type: PiiType;
  value: string;
  start: number;
  end: number;
}

interface PiiMatchCandidate extends DetectedPii {
  priority: number;
}

const MIGHT_CONTAIN_CACHE = new LRUCache<string, boolean>({ maxSize: 5000 });
const DETECT_PII_CACHE = new LRUCache<string, DetectedPii[]>({ maxSize: 5000 });

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const SECRET_PATTERNS: { name: string; regex: RegExp; type: PiiType }[] = [
  {
    name: 'openai_key',
    regex: /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
    type: 'secret',
  },
  {
    name: 'github_token',
    regex: /\b(?:gh[pousr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})\b/g,
    type: 'secret',
  },
  {
    name: 'bearer_token',
    regex: /\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi,
    type: 'secret',
  },
  {
    name: 'jwt',
    regex: /\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b/g,
    type: 'secret',
  },
  {
    name: 'pem_private_key',
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
    type: 'secret',
  },
  {
    name: 'pem_footer',
    regex: /-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
    type: 'secret',
  },
  {
    name: 'api_key_param',
    regex: /\b(?:api[_-]?key|apikey)\s*=\s*[a-zA-Z0-9_\-\.]{16,}\b/gi,
    type: 'secret',
  },
  {
    name: 'high_entropy_token',
    regex: /\b(?=[A-Za-z0-9._-]*[A-Z])[A-Za-z0-9._-]{24,}\b/g,
    type: 'secret',
  },
];

const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
const IPV6_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
const IPV6_COMPRESSED_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\b/g;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const QUICK_SECRET_HINT_REGEX = /\b(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|Bearer\s|eyJ)/;
const QUICK_IPV4_HINT_REGEX = /\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\./;

function resetRegex(regex: RegExp): RegExp {
  regex.lastIndex = 0;
  return regex;
}

function looksLikeFalsePositiveSecret(value: string): boolean {
  const falsePositives = [
    /^(https?|ftp):\/\//i,
    /^\d{4}-\d{2}-\d{2}/,
    /^v\d+\.\d+/,
    /^(true|false|null|undefined)$/i,
  ];

  for (const fp of falsePositives) {
    if (fp.test(value)) return true;
  }

  if (/^\d+$/.test(value)) return true;
  if (value.length < 8) return true;
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

function _detectPii(text: string): DetectedPii[] {
  const candidates: PiiMatchCandidate[] = [];

  function addCandidate(type: PiiType, value: string, start: number, end: number, priority: number) {
    candidates.push({ type, value, start, end, priority });
  }

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

  let match;
  const ipv4Regex = resetRegex(IPV4_REGEX);
  while ((match = ipv4Regex.exec(text)) !== null) {
    const value = match[0];
    if (!looksLikeVersionNumber(value)) {
      addCandidate('ip', value, match.index, match.index + value.length, SECRET_PATTERNS.length);
    }
  }

  const ipv6Regex = resetRegex(IPV6_REGEX);
  while ((match = ipv6Regex.exec(text)) !== null) {
    addCandidate('ip', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 1);
  }

  const ipv6CompressedRegex = resetRegex(IPV6_COMPRESSED_REGEX);
  while ((match = ipv6CompressedRegex.exec(text)) !== null) {
    addCandidate('ip', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 2);
  }

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

function looksLikeVersionNumber(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  const nums = parts.map(p => parseInt(p, 10));
  if (nums.every(n => n < 10)) return true;

  return false;
}

function _mightContainPii(text: string): boolean {
  if (!text || text.length < 3) return false;

  if (text.includes('@')) return true;
  if (QUICK_SECRET_HINT_REGEX.test(text)) return true;
  if (QUICK_IPV4_HINT_REGEX.test(text)) return true;

  return false;
}

export interface PiiHint {
  result: boolean;
  hash: string;
}

export function getPiiHint(text: string): PiiHint {
  if (!text || text.length < 3) {
    return { result: false, hash: '' };
  }

  if (text.length < 200) {
    return { result: _mightContainPii(text), hash: '' };
  }

  const hash = hashText(text);
  const cached = MIGHT_CONTAIN_CACHE.get(hash);
  if (cached !== undefined) {
    return { result: cached, hash };
  }

  const result = _mightContainPii(text);
  MIGHT_CONTAIN_CACHE.set(hash, result);
  return { result, hash };
}

export function mightContainPii(text: string): boolean {
  return getPiiHint(text).result;
}

export function detectPii(text: string, hash?: string): DetectedPii[] {
  if (!text) return [];

  const resolvedHash = hash && hash.length > 0 ? hash : hashText(text);
  const cached = DETECT_PII_CACHE.get(resolvedHash);
  if (cached !== undefined) return cached;

  const result = _detectPii(text);
  DETECT_PII_CACHE.set(resolvedHash, result);
  return result;
}
