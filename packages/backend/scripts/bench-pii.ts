import { performance } from 'node:perf_hooks';

import { detectPii } from '../src/services/pii-detector.js';
import { getOrCreateMaskedValue } from '../src/services/pii-mask-generator.js';
import { PiiStreamRestorer } from '../src/services/pii-protection-service.js';
import { createPiiProtectionContext } from '../src/services/pii-protection-types.js';

type PiiType = 'secret' | 'ip' | 'email';

type SecretPattern = {
  name: string;
  regex: RegExp;
  type: PiiType;
};

type BenchCase = {
  name: string;
  iterations: number;
  run: () => number;
};

type BenchResult = {
  name: string;
  iterations: number;
  totalMs: number;
  avgUs: number;
  opsPerSec: number;
  bytesPerIteration: number;
  mbPerSec: number;
  checksum: number;
};

const SECRET_PATTERNS: SecretPattern[] = [
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
    regex: /\b[A-Za-z0-9._-]{24,}\b/g,
    type: 'secret',
  },
];

const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
const IPV6_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
const IPV6_COMPRESSED_REGEX = /\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\b/g;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return true;

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

function looksLikeVersionNumber(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  const nums = parts.map((part) => Number.parseInt(part, 10));
  return nums.every((num) => num < 10);
}

function detectPiiLegacy(text: string): Array<{ type: PiiType; value: string; start: number; end: number }> {
  const results: Array<{ type: PiiType; value: string; start: number; end: number }> = [];
  const seenRanges = new Set<string>();

  function addResult(type: PiiType, value: string, start: number, end: number) {
    const key = `${start}:${end}`;
    if (seenRanges.has(key)) return;

    for (const range of seenRanges) {
      const [s, e] = range.split(':').map(Number);
      if ((start >= s && start < e) || (end > s && end <= e)) {
        return;
      }
    }

    seenRanges.add(key);
    results.push({ type, value, start, end });
  }

  for (const pattern of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags.replace('g', '') + 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      if (pattern.name === 'high_entropy_token' && !looksLikeConservativeGenericSecret(value)) {
        continue;
      }
      if (!looksLikeFalsePositiveSecret(value)) {
        addResult(pattern.type, value, match.index, match.index + value.length);
      }
    }
  }

  let match: RegExpExecArray | null;
  const ipv4Regex = new RegExp(IPV4_REGEX.source, 'g');
  while ((match = ipv4Regex.exec(text)) !== null) {
    const value = match[0];
    if (!looksLikeVersionNumber(value)) {
      addResult('ip', value, match.index, match.index + value.length);
    }
  }

  const ipv6Regex = new RegExp(IPV6_REGEX.source, 'g');
  while ((match = ipv6Regex.exec(text)) !== null) {
    addResult('ip', match[0], match.index, match.index + match[0].length);
  }

  const ipv6CompressedRegex = new RegExp(IPV6_COMPRESSED_REGEX.source, 'g');
  while ((match = ipv6CompressedRegex.exec(text)) !== null) {
    addResult('ip', match[0], match.index, match.index + match[0].length);
  }

  const emailRegex = new RegExp(EMAIL_REGEX.source, 'g');
  while ((match = emailRegex.exec(text)) !== null) {
    addResult('email', match[0], match.index, match.index + match[0].length);
  }

  results.sort((a, b) => a.start - b.start);
  return results;
}

function restoreLegacy(text: string, replacements: Map<string, string>): string {
  let result = text;
  for (const [masked, original] of replacements) {
    result = result.split(masked).join(original);
  }
  return result;
}

function buildLargePrompt(): string {
  const lines = [
    'customer alice@example.com connected from 192.168.10.24 with token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'forward Authorization: Bearer abcdefghijklmnopqrstuvwxyzABCDE1234567890 and github_pat_1234567890123456789012_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567',
    'replica owner bob.smith+alerts@example.org uses api_key=AbCdEf1234567890GHij-klm',
    'node reports jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.signature',
    'ipv6 path 2001:0db8:85a3:0000:0000:8a2e:0370:7334 should also be restored',
  ];

  return Array.from({ length: 120 }, (_, index) => `${index}: ${lines[index % lines.length]}`).join('\n');
}

function buildStreamDataset() {
  const ctx = createPiiProtectionContext(true);
  const originals = [
    { type: 'email' as const, value: 'alice@example.com' },
    { type: 'email' as const, value: 'bob.smith+alerts@example.org' },
    { type: 'ip' as const, value: '192.168.10.24' },
    { type: 'ip' as const, value: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
    { type: 'secret' as const, value: 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' },
    { type: 'secret' as const, value: 'Bearer abcdefghijklmnopqrstuvwxyzABCDE1234567890' },
  ];

  const maskedPairs = originals.map((item) => ({
    original: item.value,
    masked: getOrCreateMaskedValue(ctx, item.value, item.type),
  }));

  const fragmentSource = Array.from({ length: 160 }, (_, index) => {
    const pair = maskedPairs[index % maskedPairs.length];
    return `chunk-${index}:${pair.masked}|`;
  }).join('');

  const chunkSizes = [3, 5, 7, 11, 13, 17];
  const fragments: string[] = [];
  let cursor = 0;
  let chunkIndex = 0;
  while (cursor < fragmentSource.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length];
    fragments.push(fragmentSource.slice(cursor, cursor + size));
    cursor += size;
    chunkIndex += 1;
  }

  return {
    ctx,
    replacements: new Map(maskedPairs.map((pair) => [pair.masked, pair.original])),
    fragments,
    totalBytes: fragmentSource.length,
  };
}

function runBench({ name, iterations, run }: BenchCase, bytesPerIteration: number): BenchResult {
  let checksum = 0;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index++) {
    checksum += run();
  }
  const totalMs = performance.now() - startedAt;
  const avgUs = (totalMs * 1000) / iterations;
  const opsPerSec = iterations / (totalMs / 1000);
  const mbPerSec = bytesPerIteration > 0
    ? (bytesPerIteration * iterations) / (1024 * 1024) / (totalMs / 1000)
    : 0;

  return {
    name,
    iterations,
    totalMs,
    avgUs,
    opsPerSec,
    bytesPerIteration,
    mbPerSec,
    checksum,
  };
}

function printResult(result: BenchResult) {
  const parts = [
    result.name.padEnd(28),
    `${result.totalMs.toFixed(2).padStart(10)} ms`,
    `${result.avgUs.toFixed(2).padStart(10)} us/op`,
    `${result.opsPerSec.toFixed(0).padStart(10)} ops/s`,
  ];

  if (result.bytesPerIteration > 0) {
    parts.push(`${result.mbPerSec.toFixed(2).padStart(10)} MiB/s`);
  }

  parts.push(`checksum=${result.checksum}`);
  console.log(parts.join('  '));
}

function printComparison(current: BenchResult, legacy: BenchResult) {
  const speedup = legacy.totalMs / current.totalMs;
  const saved = ((legacy.totalMs - current.totalMs) / legacy.totalMs) * 100;
  console.log(
    `${current.name}: ${speedup.toFixed(2)}x faster, ${saved.toFixed(1)}% less wall time than legacy`
  );
}

const detectText = buildLargePrompt();
const detectIterations = 1_500;

const streamDataset = buildStreamDataset();
const streamIterations = 2_500;

const cases: Array<{ current: BenchResult; legacy: BenchResult }> = [
  {
    current: runBench({
      name: 'detectPii current',
      iterations: detectIterations,
      run: () => detectPii(detectText).length,
    }, detectText.length),
    legacy: runBench({
      name: 'detectPii legacy',
      iterations: detectIterations,
      run: () => detectPiiLegacy(detectText).length,
    }, detectText.length),
  },
  {
    current: runBench({
      name: 'stream restore current',
      iterations: streamIterations,
      run: () => {
        const restorer = new PiiStreamRestorer(streamDataset.ctx);
        let total = 0;
        for (const fragment of streamDataset.fragments) {
          total += restorer.process('chat:0:content', fragment).length;
        }
        total += restorer.flush('chat:0:content').length;
        return total;
      },
    }, streamDataset.totalBytes),
    legacy: runBench({
      name: 'stream restore legacy',
      iterations: streamIterations,
      run: () => {
        let pending = '';
        let total = 0;
        let maxMaskedValueLen = 1;
        for (const masked of streamDataset.replacements.keys()) {
          if (masked.length > maxMaskedValueLen) {
            maxMaskedValueLen = masked.length;
          }
        }

        for (const fragment of streamDataset.fragments) {
          const combined = restoreLegacy(pending + fragment, streamDataset.replacements);
          const keep = Math.min(maxMaskedValueLen - 1, combined.length);
          total += combined.slice(0, combined.length - keep).length;
          pending = combined.slice(combined.length - keep);
        }

        total += restoreLegacy(pending, streamDataset.replacements).length;
        return total;
      },
    }, streamDataset.totalBytes),
  },
];

console.log('PII benchmark on current machine');
console.log(`Node ${process.version}`);
console.log('');

for (const pair of cases) {
  printResult(pair.current);
  printResult(pair.legacy);
  printComparison(pair.current, pair.legacy);
  console.log('');
}
