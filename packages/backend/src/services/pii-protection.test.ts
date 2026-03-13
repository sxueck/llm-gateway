/**
 * PII Protection - Simple verification tests
 *
 * Tests for request-scoped mapping and SSE cross-chunk restore.
 * Run with: node --experimental-strip-types pii-protection.test.ts
 */

import { createPiiProtectionContext } from './pii-protection-types.js';
import { detectPii } from './pii-detector.js';
import { generateMaskedValue, getOrCreateMaskedValue } from './pii-mask-generator.js';
import { PiiStreamRestorer } from './pii-protection-service.js';
import { processOpenAIChatCompletionStreamToSse } from '../utils/stream-processor.js';

// Test data
const TEST_EMAIL = 'user@example.com';
const TEST_IP = '192.168.1.100';
const TEST_SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';

function testBasicDetection() {
  console.log('\n=== Test: Basic Detection ===');

  const text = `Contact ${TEST_EMAIL} at ${TEST_IP} with key ${TEST_SECRET}`;
  const detections = detectPii(text);

  console.log(`  Input: ${text}`);
  console.log(`  Detected ${detections.length} items:`);

  const hasEmail = detections.some(d => d.type === 'email');
  const hasIp = detections.some(d => d.type === 'ip');
  const hasSecret = detections.some(d => d.type === 'secret');

  console.log(`  - Email: ${hasEmail ? '✓' : '✗'}`);
  console.log(`  - IP: ${hasIp ? '✓' : '✗'}`);
  console.log(`  - Secret: ${hasSecret ? '✓' : '✗'}`);

  return hasEmail && hasIp && hasSecret;
}

function testStableMapping() {
  console.log('\n=== Test: Request-Scoped Stable Mapping ===');

  const ctx = createPiiProtectionContext(true);

  // Same original should map to same masked value
  const masked1 = getOrCreateMaskedValue(ctx, TEST_EMAIL, 'email');
  const masked2 = getOrCreateMaskedValue(ctx, TEST_EMAIL, 'email');

  console.log(`  Original: ${TEST_EMAIL}`);
  console.log(`  Masked 1: ${masked1}`);
  console.log(`  Masked 2: ${masked2}`);
  console.log(`  Same masked value: ${masked1 === masked2 ? '✓' : '✗'}`);

  // Check reverse mapping
  const restored = ctx.reverseReplacements.get(masked1);
  console.log(`  Restored: ${restored}`);
  console.log(`  Correct restoration: ${restored === TEST_EMAIL ? '✓' : '✗'}`);

  return masked1 === masked2 && restored === TEST_EMAIL;
}

function testLengthPreservation() {
  console.log('\n=== Test: Length Preservation ===');

  const testCases: { value: string; type: 'secret' | 'ip' | 'email' }[] = [
    { value: TEST_SECRET, type: 'secret' },
    { value: TEST_IP, type: 'ip' },
    { value: TEST_EMAIL, type: 'email' },
    { value: '1.22.3.44', type: 'ip' },
    { value: 'ab.cd+12@x-y.zw', type: 'email' },
  ];

  let allPass = true;
  for (const tc of testCases) {
    const masked = generateMaskedValue(tc.value, tc.type);
    const sameLength = masked.length === tc.value.length;
    const sameStructure = [...tc.value].every((char, idx) => {
      if (/[^A-Za-z0-9]/.test(char)) {
        return masked[idx] === char;
      }
      if (/[A-Z]/.test(char)) return /[A-Z]/.test(masked[idx]);
      if (/[a-z]/.test(char)) return /[a-z]/.test(masked[idx]);
      if (/[0-9]/.test(char)) return /[0-9]/.test(masked[idx]);
      return true;
    });
    const pass = sameLength && sameStructure;
    console.log(`  ${tc.type}: ${tc.value} -> ${masked} ${pass ? '✓' : '✗'}`);
    if (!pass) allPass = false;
  }

  return allPass;
}

function createMockReply() {
  const writes: string[] = [];
  const raw = {
    destroyed: false,
    writableEnded: false,
    writeHead: (_status: number, _headers: Record<string, string>) => {},
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    once: (_event: string, handler: () => void) => {
      handler();
    },
    end: () => {
      raw.writableEnded = true;
    },
  };

  return {
    raw,
    writes,
  };
}

function testStreamRestorerPrimitive() {
  console.log('\n=== Test: Stream Restorer Primitive ===');
  const ctx = createPiiProtectionContext(true);
  const original = 'Hello world';
  const masked = getOrCreateMaskedValue(ctx, original, 'secret');

  console.log(`  Original: ${original}`);
  console.log(`  Masked: ${masked}`);

  const restorer = new PiiStreamRestorer(ctx);

  // Simulate chunked stream where masked value is split across chunks
  const chunk1 = masked.slice(0, 5);
  const chunk2 = masked.slice(5);

  console.log(`  Chunk 1: "${chunk1}"`);
  console.log(`  Chunk 2: "${chunk2}"`);

  const key = 'test:0:content';

  // Process first chunk (will buffer since partial match possible)
  const result1 = restorer.process(key, chunk1);
  console.log(`  After chunk 1: "${result1}" (buffered partial)`);

  // Process second chunk
  const result2 = restorer.process(key, chunk2);
  console.log(`  After chunk 2: "${result2}"`);

  // Flush any remaining
  const flushed = restorer.flush(key);
  console.log(`  Flushed: "${flushed}"`);

  // Combined result should have original restored
  const combined = result1 + result2 + flushed;
  const restored = combined.split(masked).join(original);

  console.log(`  Combined: "${combined}"`);
  console.log(`  Restored: "${restored}"`);
  console.log(`  Restore correct: ${restored.includes(original) ? '✓' : '✗'}`);

  return restored.includes(original);
}

async function testChatSseCrossChunkRestoreExecution() {
  console.log('\n=== Test: Chat SSE Cross-Chunk Restore Execution ===');

  const ctx = createPiiProtectionContext(true);
  const original = TEST_SECRET;
  const masked = getOrCreateMaskedValue(ctx, original, 'secret');
  const midpoint = Math.floor(masked.length / 2);
  const reply = createMockReply();

  async function* stream() {
    yield {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: masked.slice(0, midpoint) }, finish_reason: null }],
    };
    yield {
      id: 'chunk-2',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: masked.slice(midpoint) }, finish_reason: 'stop' }],
    };
  }

  await processOpenAIChatCompletionStreamToSse({
    reply: reply as any,
    stream: stream(),
    model: 'test-model',
    streamRestorer: new PiiStreamRestorer(ctx),
  });

  const payload = reply.writes.join('');
  const pass = payload.includes(original) && !payload.includes(masked);
  console.log(`  SSE payload restored original: ${pass ? '✓' : '✗'}`);

  return pass;
}

function testConservativeSecretDetection() {
  console.log('\n=== Test: Conservative Secret Detection ===');

  // These should NOT be detected as secrets
  const falsePositives = [
    'This is just a long sentence without any secret patterns',
    'v1.2.3.4',  // Version number
    '2024-01-01',  // Date
    'true false null undefined',  // JSON literals
    'The meeting is at 123 Main Street',  // Address
    'Call me at 555-1234',  // Phone (not detected in v1)
    '0123456789abcdef0123456789abcdef',  // Hex hash
    '550e8400-e29b-41d4-a716-446655440000',  // UUID
    'customer_20260313_abcd1234efgh5678',  // Long identifier
  ];

  let allPass = true;
  for (const text of falsePositives) {
    const detections = detectPii(text);
    const secretCount = detections.filter(d => d.type === 'secret').length;
    const pass = secretCount === 0;
    console.log(`  "${text.substring(0, 40)}..." - Secrets: ${secretCount} ${pass ? '✓' : '✗'}`);
    if (!pass) allPass = false;
  }

  return allPass;
}

// Run all tests
async function main() {
  console.log('PII Protection Tests');
  console.log('====================');

  const results = {
    detection: testBasicDetection(),
    stableMapping: testStableMapping(),
    lengthPreservation: testLengthPreservation(),
    streamRestorerPrimitive: testStreamRestorerPrimitive(),
    chatSseCrossChunkRestore: await testChatSseCrossChunkRestoreExecution(),
    conservativeSecret: testConservativeSecretDetection(),
  };

  console.log('\n=== Summary ===');
  let allPass = true;
  for (const [name, passed] of Object.entries(results)) {
    console.log(`  ${name}: ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed) allPass = false;
  }

  console.log(`\nOverall: ${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

void main();
