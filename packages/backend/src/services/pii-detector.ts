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

/**
 * Upper bound (in characters) for a single text field that we are willing to scan.
 *
 * Large fields are almost always code / file dumps / pasted logs in coding
 * scenarios. Scanning them is both the dominant CPU cost (and a freeze risk on
 * pathological inputs) and the main source of model-quality degradation, since
 * masking corrupts the surrounding code the model needs to reason about.
 *
 * We deliberately favour missed detections (漏检) over CPU spikes and quality
 * loss: oversized fields are skipped entirely. Tunable via env.
 */
const MAX_FIELD_SCAN_LENGTH = parseInt(process.env.PII_MAX_FIELD_SCAN_LENGTH || '50000', 10);

/**
 * Upper bound on the number of raw match candidates collected per field.
 *
 * Sorting candidates and building the overlap index still use CPU and memory
 * proportional to the match count. A field full of IPs/emails (pasted logs)
 * can stall the event loop; once the cap is hit we stop collecting (accept 漏检).
 */
const MAX_MATCHES_PER_FIELD = parseInt(process.env.PII_MAX_MATCHES_PER_FIELD || '2000', 10);

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
];

const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
const IPV6_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
const IPV6_COMPRESSED_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\b/g;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g;
const QUICK_SECRET_HINT_REGEX = /\b(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|Bearer\s|eyJ)/;
const QUICK_IPV4_HINT_REGEX = /\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\./;
// Linear, non-global email shape check. Used instead of a bare `includes('@')`
// so that decorators, scoped npm packages (@scope/pkg), handles, etc. in code
// don't force the expensive full detection pass. Quantifiers are bounded to RFC
// limits so separator-heavy code (long kebab-case runs) can't cause O(n^2)
// backtracking while scanning for a following '@'.
const QUICK_EMAIL_HINT_REGEX = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/;

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

function _detectPii(text: string): DetectedPii[] {
  // Skip oversized fields entirely. These are dominated by code/log dumps where
  // scanning is both the main CPU/freeze risk and the main quality risk
  // (masking corrupts the code). We accept missed detections here by design.
  if (text.length > MAX_FIELD_SCAN_LENGTH) {
    return [];
  }

  const candidates: PiiMatchCandidate[] = [];

  function addCandidate(type: PiiType, value: string, start: number, end: number, priority: number): boolean {
    candidates.push({ type, value, start, end, priority });
    return candidates.length < MAX_MATCHES_PER_FIELD;
  }

  for (let priority = 0; priority < SECRET_PATTERNS.length; priority++) {
    const pattern = SECRET_PATTERNS[priority];
    const regex = resetRegex(pattern.regex);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      if (!looksLikeFalsePositiveSecret(value)) {
        if (!addCandidate(pattern.type, value, match.index, match.index + value.length, priority)) {
          return finalizeCandidates(candidates);
        }
      }
    }
  }

  let match;
  const ipv4Regex = resetRegex(IPV4_REGEX);
  while ((match = ipv4Regex.exec(text)) !== null) {
    const value = match[0];
    if (!looksLikeVersionNumber(value)) {
      if (!addCandidate('ip', value, match.index, match.index + value.length, SECRET_PATTERNS.length)) {
        return finalizeCandidates(candidates);
      }
    }
  }

  const ipv6Regex = resetRegex(IPV6_REGEX);
  while ((match = ipv6Regex.exec(text)) !== null) {
    if (!addCandidate('ip', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 1)) {
      return finalizeCandidates(candidates);
    }
  }

  const ipv6CompressedRegex = resetRegex(IPV6_COMPRESSED_REGEX);
  while ((match = ipv6CompressedRegex.exec(text)) !== null) {
    if (!addCandidate('ip', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 2)) {
      return finalizeCandidates(candidates);
    }
  }

  const emailRegex = resetRegex(EMAIL_REGEX);
  while ((match = emailRegex.exec(text)) !== null) {
    if (!addCandidate('email', match[0], match.index, match.index + match[0].length, SECRET_PATTERNS.length + 3)) {
      return finalizeCandidates(candidates);
    }
  }

  return finalizeCandidates(candidates);
}

class IntervalOverlapIndex {
  private readonly segmentCount: number;
  private readonly max: number[];
  private readonly lazy: number[];

  constructor(coordinates: number[]) {
    this.segmentCount = Math.max(1, coordinates.length - 1);
    this.max = Array.from({ length: this.segmentCount * 4 }, () => 0);
    this.lazy = Array.from({ length: this.segmentCount * 4 }, () => 0);
  }

  hasOverlap(start: number, end: number): boolean {
    if (start >= end) return false;
    return this.query(1, 0, this.segmentCount - 1, start, end - 1) > 0;
  }

  add(start: number, end: number): void {
    if (start >= end) return;
    this.update(1, 0, this.segmentCount - 1, start, end - 1);
  }

  private apply(node: number, amount: number): void {
    this.max[node] += amount;
    this.lazy[node] += amount;
  }

  private push(node: number): void {
    const amount = this.lazy[node];
    if (amount === 0) return;
    this.apply(node * 2, amount);
    this.apply(node * 2 + 1, amount);
    this.lazy[node] = 0;
  }

  private update(node: number, left: number, right: number, start: number, end: number): void {
    if (start <= left && right <= end) {
      this.apply(node, 1);
      return;
    }

    this.push(node);
    const middle = Math.floor((left + right) / 2);
    if (start <= middle) {
      this.update(node * 2, left, middle, start, end);
    }
    if (end > middle) {
      this.update(node * 2 + 1, middle + 1, right, start, end);
    }
    this.max[node] = Math.max(this.max[node * 2], this.max[node * 2 + 1]);
  }

  private query(node: number, left: number, right: number, start: number, end: number): number {
    if (start <= left && right <= end) return this.max[node];

    this.push(node);
    const middle = Math.floor((left + right) / 2);
    let result = 0;
    if (start <= middle) {
      result = Math.max(result, this.query(node * 2, left, middle, start, end));
    }
    if (end > middle) {
      result = Math.max(result, this.query(node * 2 + 1, middle + 1, right, start, end));
    }
    return result;
  }
}

function finalizeCandidates(candidates: PiiMatchCandidate[]): DetectedPii[] {
  candidates.sort((a, b) => a.priority - b.priority || a.start - b.start || b.end - a.end);

  const coordinates = [...new Set(candidates.flatMap(candidate => [candidate.start, candidate.end]))].sort(
    (a, b) => a - b,
  );
  const coordinateIndex = new Map(coordinates.map((coordinate, index) => [coordinate, index]));
  const overlapIndex = new IntervalOverlapIndex(coordinates);
  const accepted: PiiMatchCandidate[] = [];

  // Half-open coordinate segments preserve the existing start/end overlap semantics.
  for (const candidate of candidates) {
    const start = coordinateIndex.get(candidate.start);
    const end = coordinateIndex.get(candidate.end);
    if (start === undefined || end === undefined) continue;
    if (overlapIndex.hasOverlap(start, end)) continue;
    overlapIndex.add(start, end);
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
  if (text.length > MAX_FIELD_SCAN_LENGTH) return false;

  if (text.includes('@') && QUICK_EMAIL_HINT_REGEX.test(text)) return true;
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

  // Oversized fields are skipped by the detector anyway; avoid hashing huge
  // (multi-MB) payloads here, which is itself a meaningful CPU cost.
  if (text.length > MAX_FIELD_SCAN_LENGTH) {
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

export function detectPii(text: string, hash?: string): DetectedPii[] {
  if (!text) return [];
  // Skip oversized fields before hashing to keep the hot path bounded.
  if (text.length > MAX_FIELD_SCAN_LENGTH) return [];

  const resolvedHash = hash && hash.length > 0 ? hash : hashText(text);
  const cached = DETECT_PII_CACHE.get(resolvedHash);
  if (cached !== undefined) return cached;

  const result = _detectPii(text);
  DETECT_PII_CACHE.set(resolvedHash, result);
  return result;
}
