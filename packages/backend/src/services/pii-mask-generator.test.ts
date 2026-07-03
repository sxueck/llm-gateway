import { describe, test, expect } from 'vitest';

import { getOrCreateMaskedValue, generateMaskedValue } from './pii-mask-generator.js';
import { createPiiProtectionContext } from './pii-protection-types.js';

function maskAll(values: Array<[string, 'email' | 'ip' | 'secret']>): Map<string, string> {
  const ctx = createPiiProtectionContext(true);
  const out = new Map<string, string>();
  for (const [v, t] of values) out.set(v, getOrCreateMaskedValue(ctx, v, t));
  return out;
}

describe('pii surrogate determinism (KV-cache stability)', () => {
  // The masked prefix sent upstream must be byte-identical across requests so
  // provider prompt/KV caching keeps hitting in multi-turn conversations.
  test('same original yields same surrogate regardless of request composition/order', () => {
    const r1 = maskAll([['alice@xx.com', 'email'], ['bobby@yy.com', 'email']]);
    const r2 = maskAll([['carol@zz.com', 'email'], ['alice@xx.com', 'email'], ['bobby@yy.com', 'email']]);
    expect(r1.get('alice@xx.com')).toBe(r2.get('alice@xx.com'));
    expect(r1.get('bobby@yy.com')).toBe(r2.get('bobby@yy.com'));
  });

  test('different same-shaped originals do not collide to the same surrogate', () => {
    const m = maskAll([['alice@xx.com', 'email'], ['bobby@yy.com', 'email']]);
    expect(m.get('alice@xx.com')).not.toBe(m.get('bobby@yy.com'));
  });

  test('surrogate generation is a pure function of value/type', () => {
    expect(generateMaskedValue('alice@example.com', 'email')).toBe(
      generateMaskedValue('alice@example.com', 'email')
    );
    expect(generateMaskedValue('203.0.113.42', 'ip')).toBe(
      generateMaskedValue('203.0.113.42', 'ip')
    );
  });

  test('preserves length and structural separators', () => {
    const masked = generateMaskedValue('alice@example.com', 'email');
    expect(masked).toHaveLength('alice@example.com'.length);
    expect(masked.indexOf('@')).toBe('alice@example.com'.indexOf('@'));
  });
});

describe('pii mask variant space (collision / death-loop regression)', () => {
  // Regression: IPv4 pools are only 6 wide and `variant` used to be a
  // synchronized global offset, so 7+ same-shape IPs exhausted the space.
  test('IPv4 mask produces many distinct surrogates across variants', () => {
    const seen = new Set<string>();
    for (let v = 0; v < 40; v++) seen.add(generateMaskedValue('10.0.8.56', 'ip', v));
    expect(seen.size).toBeGreaterThan(20);
  });

  test('IPv6 mask produces many distinct surrogates across variants', () => {
    const seen = new Set<string>();
    for (let v = 0; v < 40; v++) seen.add(generateMaskedValue('2001:db8::1', 'ip', v));
    expect(seen.size).toBeGreaterThan(20);
  });

  test('masking many same-shape IPs never loops and keeps surrogates unique', () => {
    const ctx = createPiiProtectionContext(true);
    const masked = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const m = getOrCreateMaskedValue(ctx, `10.20.${i % 100}.${i}`, 'ip');
      // Every distinct original must map to a distinct surrogate.
      expect(masked.has(m)).toBe(false);
      masked.add(m);
    }
    expect(masked.size).toBe(200);
  });

  test('repeated masking of the same original is idempotent', () => {
    const ctx = createPiiProtectionContext(true);
    const first = getOrCreateMaskedValue(ctx, '203.0.113.42', 'ip');
    const second = getOrCreateMaskedValue(ctx, '203.0.113.42', 'ip');
    expect(second).toBe(first);
  });
});
