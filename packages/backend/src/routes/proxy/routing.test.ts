import { describe, it, test, expect } from 'vitest';

import { circuitBreaker } from '../../services/circuit-breaker.js';
import { getTargetKey, hasAvailableRoutingTargets, selectRoutingTarget, getAnonymousAffinityTargetKey, countExplicitSessionBindings, shouldRetrySmartRouting, normalizeRoutingStrategy, extractRequestRoutingStrategy, resolveConfigDefaultStrategy, computeBlendedPrice, sortTargetsForStrategy, type RoutingConfig } from './routing.js';

test('selectRoutingTarget rotates loadbalance targets without weights', () => {
  circuitBreaker.resetAll();

  const config: RoutingConfig = {
    strategy: { mode: 'loadbalance' },
    targets: [
      { provider: 'provider-a' },
      { provider: 'provider-b' },
      { provider: 'provider-c' },
    ],
  };

  const selectedProviders = [
    selectRoutingTarget(config, 'loadbalance', 'loadbalance-rotation-test-1')?.provider,
    selectRoutingTarget(config, 'loadbalance', 'loadbalance-rotation-test-1')?.provider,
    selectRoutingTarget(config, 'loadbalance', 'loadbalance-rotation-test-1')?.provider,
    selectRoutingTarget(config, 'loadbalance', 'loadbalance-rotation-test-1')?.provider,
  ];

  expect(selectedProviders).toEqual(['provider-a', 'provider-b', 'provider-c', 'provider-a']);
});

test('selectRoutingTarget excludes only the failed target key under same provider', () => {
  circuitBreaker.resetAll();

  const config: RoutingConfig = {
    strategy: { mode: 'loadbalance' },
    targets: [
      { provider: 'provider-a', override_params: { model: 'model-1' } },
      { provider: 'provider-a', override_params: { model: 'model-2' } },
    ],
  };

  const failedTargetKey = getTargetKey(config.targets[0]!);
  const selectedTarget = selectRoutingTarget(
    config,
    'loadbalance',
    'target-key-exclusion-test-1',
    undefined,
    new Set([failedTargetKey])
  );

  expect(selectedTarget?.provider).toBe('provider-a');
  expect(selectedTarget?.override_params?.model).toBe('model-2');
});

test('selectRoutingTarget prefers highest remaining weight during loadbalance retry', () => {
  circuitBreaker.resetAll();

  const config: RoutingConfig = {
    strategy: { mode: 'loadbalance' },
    targets: [
      { provider: 'provider-a', weight: 100 },
      { provider: 'provider-b', weight: 50 },
      { provider: 'provider-c', weight: 10 },
    ],
  };

  const selectedTarget = selectRoutingTarget(
    config,
    'loadbalance',
    'loadbalance-weighted-retry-test-1',
    undefined,
    new Set([getTargetKey(config.targets[0]!)])
  );

  expect(selectedTarget?.provider).toBe('provider-b');
});

test('selectRoutingTarget keeps round-robin order when a middle target is excluded', () => {
  circuitBreaker.resetAll();

  const config: RoutingConfig = {
    strategy: { mode: 'loadbalance' },
    targets: [
      { provider: 'provider-a' },
      { provider: 'provider-b' },
      { provider: 'provider-c' },
    ],
  };

  const configId = 'loadbalance-exclusion-order-test-1';
  const firstTarget = selectRoutingTarget(config, 'loadbalance', configId);
  const secondTarget = selectRoutingTarget(config, 'loadbalance', configId);
  const thirdTarget = selectRoutingTarget(
    config,
    'loadbalance',
    configId,
    undefined,
    new Set([getTargetKey(config.targets[1]!)])
  );
  const fourthTarget = selectRoutingTarget(config, 'loadbalance', configId);

  expect(firstTarget?.provider).toBe('provider-a');
  expect(secondTarget?.provider).toBe('provider-b');
  expect(thirdTarget?.provider).toBe('provider-c');
  expect(fourthTarget?.provider).toBe('provider-a');
});

test('hasAvailableRoutingTargets returns false after all targets are excluded', () => {
  circuitBreaker.resetAll();

  const config: RoutingConfig = {
    strategy: { mode: 'loadbalance' },
    targets: [
      { provider: 'provider-a' },
      { provider: 'provider-b' },
    ],
  };

  const excludedTargetKeys = new Set(config.targets.map(target => getTargetKey(target)));

  expect(hasAvailableRoutingTargets(config, excludedTargetKeys)).toBe(false);
  expect(selectRoutingTarget(config, 'loadbalance', 'all-targets-excluded-test-1', undefined, excludedTargetKeys)).toBeNull();
});

test('affinity reroutes to the next weighted target and keeps affinity there', () => {
  circuitBreaker.resetAll();

  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'affinity', affinityTTL: 60_000 },
      targets: [
        { provider: 'provider-a', weight: 100 },
        { provider: 'provider-b', weight: 50 },
        { provider: 'provider-c', weight: 10 },
      ],
    };

    const affinityKey = 'session-1';
    const firstTarget = selectRoutingTarget(config, 'affinity', 'affinity-reroute-test-1', affinityKey);
    const reroutedTarget = selectRoutingTarget(
      config,
      'affinity',
      'affinity-reroute-test-1',
      affinityKey,
      new Set([getTargetKey(firstTarget!)])
    );
    const stickyTarget = selectRoutingTarget(config, 'affinity', 'affinity-reroute-test-1', affinityKey);

    expect(firstTarget?.provider).toBe('provider-a');
    expect(reroutedTarget?.provider).toBe('provider-b');
    expect(stickyTarget?.provider).toBe('provider-b');
  } finally {
    Math.random = originalRandom;
  }
});

test('affinity selects each new explicit session independently by weight', () => {
  circuitBreaker.resetAll();

  const originalRandom = Math.random;
  let callCount = 0;
  Math.random = () => {
    callCount++;
    return callCount === 1 ? 0 : 0.999;
  };

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'affinity', affinityTTL: 60_000 },
      targets: [
        { provider: 'provider-a', weight: 100 },
        { provider: 'provider-b', weight: 1 },
      ],
    };

    const firstSessionFirstTarget = selectRoutingTarget(
      config,
      'affinity',
      'explicit-weighted-session-test-1',
      'session-1'
    );
    const secondSessionFirstTarget = selectRoutingTarget(
      config,
      'affinity',
      'explicit-weighted-session-test-1',
      'session-2'
    );
    const firstSessionStickyTarget = selectRoutingTarget(
      config,
      'affinity',
      'explicit-weighted-session-test-1',
      'session-1'
    );
    const secondSessionStickyTarget = selectRoutingTarget(
      config,
      'affinity',
      'explicit-weighted-session-test-1',
      'session-2'
    );

    expect(firstSessionFirstTarget?.provider).toBe('provider-a');
    expect(secondSessionFirstTarget?.provider).toBe('provider-b');
    expect(firstSessionStickyTarget?.provider).toBe('provider-a');
    expect(secondSessionStickyTarget?.provider).toBe('provider-b');
  } finally {
    Math.random = originalRandom;
  }
});

test('loadbalance retry can probe a half-open target after all healthy targets are exhausted', async () => {
  circuitBreaker.resetAll();

  const originalTimeout = (circuitBreaker as any).config.timeout;
  (circuitBreaker as any).config.timeout = 1;

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'loadbalance' },
      targets: [
        { provider: 'provider-a', weight: 100 },
        { provider: 'provider-b', weight: 50 },
      ],
    };

    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b down'));
    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b still down'));
    await new Promise(resolve => setTimeout(resolve, 20));

    const selectedTarget = selectRoutingTarget(
      config,
      'loadbalance',
      'half-open-probe-test-1',
      undefined,
      new Set([getTargetKey(config.targets[0]!)])
    );

    expect(selectedTarget?.provider).toBe('provider-b');
  } finally {
    (circuitBreaker as any).config.timeout = originalTimeout;
    circuitBreaker.resetAll();
  }
});

test('hasAvailableRoutingTargets does not consume half-open attempts during passive checks', async () => {
  circuitBreaker.resetAll();

  const originalTimeout = (circuitBreaker as any).config.timeout;
  const originalHalfOpenMaxAttempts = (circuitBreaker as any).config.halfOpenMaxAttempts;

  (circuitBreaker as any).config.timeout = 1;
  (circuitBreaker as any).config.halfOpenMaxAttempts = 1;

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'loadbalance' },
      targets: [
        { provider: 'provider-a' },
        { provider: 'provider-b' },
      ],
    };

    circuitBreaker.recordFailure(getTargetKey(config.targets[0]!), new Error('provider-a down'));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(hasAvailableRoutingTargets(config, new Set([getTargetKey(config.targets[1]!)]))).toBe(true);

    const selectedTarget = selectRoutingTarget(
      config,
      'loadbalance',
      'half-open-passive-check-test-1',
      undefined,
      new Set([getTargetKey(config.targets[1]!)])
    );

    expect(selectedTarget?.provider).toBe('provider-a');
  } finally {
    (circuitBreaker as any).config.timeout = originalTimeout;
    (circuitBreaker as any).config.halfOpenMaxAttempts = originalHalfOpenMaxAttempts;
    circuitBreaker.resetAll();
  }
});

test('selectRoutingTarget does not spend half-open attempts on unselected fallback targets', async () => {
  circuitBreaker.resetAll();

  const originalTimeout = (circuitBreaker as any).config.timeout;
  const originalHalfOpenMaxAttempts = (circuitBreaker as any).config.halfOpenMaxAttempts;

  (circuitBreaker as any).config.timeout = 1;
  (circuitBreaker as any).config.halfOpenMaxAttempts = 1;

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'fallback' },
      targets: [
        { provider: 'provider-a' },
        { provider: 'provider-b' },
      ],
    };

    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b down'));
    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b still down'));
    await new Promise(resolve => setTimeout(resolve, 20));

    const selectedTarget = selectRoutingTarget(config, 'fallback', 'fallback-half-open-spend-test-1');
    const halfOpenStats = circuitBreaker.getProviderStats(getTargetKey(config.targets[1]!));

    expect(selectedTarget?.provider).toBe('provider-a');
    expect(halfOpenStats.state).toBe('OPEN');
    expect(halfOpenStats.halfOpenAttempts).toBe(0);
  } finally {
    (circuitBreaker as any).config.timeout = originalTimeout;
    (circuitBreaker as any).config.halfOpenMaxAttempts = originalHalfOpenMaxAttempts;
    circuitBreaker.resetAll();
  }
});

test('fallback periodically probes cooled-down targets even when one healthy target stays available', async () => {
  circuitBreaker.resetAll();

  const originalTimeout = (circuitBreaker as any).config.timeout;
  const originalHalfOpenMaxAttempts = (circuitBreaker as any).config.halfOpenMaxAttempts;

  (circuitBreaker as any).config.timeout = 1;
  (circuitBreaker as any).config.halfOpenMaxAttempts = 3;

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'fallback' },
      targets: [
        { provider: 'provider-a' },
        { provider: 'provider-b' },
        { provider: 'provider-c' },
      ],
    };

    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b down'));
    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b still down'));
    circuitBreaker.recordFailure(getTargetKey(config.targets[2]!), new Error('provider-c down'));
    circuitBreaker.recordFailure(getTargetKey(config.targets[2]!), new Error('provider-c still down'));
    await new Promise(resolve => setTimeout(resolve, 20));

    const selectedProviders = Array.from({ length: 20 }, () =>
      selectRoutingTarget(config, 'fallback', 'fallback-half-open-probe-test-1')?.provider
    );

    expect(selectedProviders.filter(provider => provider === 'provider-a').length).toBe(18);
    expect(selectedProviders.filter(provider => provider === 'provider-b').length).toBe(1);
    expect(selectedProviders.filter(provider => provider === 'provider-c').length).toBe(1);
  } finally {
    (circuitBreaker as any).config.timeout = originalTimeout;
    (circuitBreaker as any).config.halfOpenMaxAttempts = originalHalfOpenMaxAttempts;
    circuitBreaker.resetAll();
  }
});

test('getAnonymousAffinityTargetKey returns the sticky target for anonymous affinity and does not count as explicit session', () => {
  circuitBreaker.resetAll();

  const config: RoutingConfig = {
    strategy: { mode: 'affinity', affinityTTL: 60_000 },
    targets: [
      { provider: 'provider-a' },
      { provider: 'provider-b' },
    ],
  };

  const selected = selectRoutingTarget(config, 'affinity', 'anonymous-affinity-test-2');
  const stickyKey = getAnonymousAffinityTargetKey('anonymous-affinity-test-2');

  expect(stickyKey).toBe(getTargetKey(selected!));
  expect(countExplicitSessionBindings('anonymous-affinity-test-2', getTargetKey(selected!))).toBe(0);
});

test('getAnonymousAffinityTargetKey returns null when no anonymous affinity exists', () => {
  const stickyKey = getAnonymousAffinityTargetKey('nonexistent-config-id');
  expect(stickyKey).toBeNull();
});

test('countExplicitSessionBindings counts only non-expired explicit sessions for a target', () => {
  circuitBreaker.resetAll();

  const config: RoutingConfig = {
    strategy: { mode: 'affinity', affinityTTL: 60_000 },
    targets: [
      { provider: 'provider-a' },
      { provider: 'provider-b' },
    ],
  };

  selectRoutingTarget(config, 'affinity', 'explicit-binding-test-1', 'session-1');
  selectRoutingTarget(config, 'affinity', 'explicit-binding-test-1', 'session-2');
  selectRoutingTarget(config, 'affinity', 'explicit-binding-test-1', 'session-3');

  expect(countExplicitSessionBindings('explicit-binding-test-1', getTargetKey(config.targets[0]!))).toBe(2);
  expect(countExplicitSessionBindings('explicit-binding-test-1', getTargetKey(config.targets[1]!))).toBe(1);
});

test('hash mode does not drift target when probe mechanism is triggered', async () => {
  circuitBreaker.resetAll();

  const originalTimeout = (circuitBreaker as any).config.timeout;
  const originalHalfOpenMaxAttempts = (circuitBreaker as any).config.halfOpenMaxAttempts;

  (circuitBreaker as any).config.timeout = 1;
  // 给 HALF_OPEN 目标充足的尝试次数，避免测试期间因次数耗尽导致重试
  (circuitBreaker as any).config.halfOpenMaxAttempts = 100;

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'hash', hashSource: 'request' },
      targets: [
        { provider: 'provider-a' },
        { provider: 'provider-b' },
      ],
    };

    // 让 provider-b 进入 OPEN 状态（后续可能进入 HALF_OPEN）
    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b down'));
    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b still down'));
    await new Promise(resolve => setTimeout(resolve, 20));

    const hashKey = 'stable-hash-key-123';
    const selectedProviders: (string | undefined)[] = [];

    // 发起 20 次请求，probe 机制每 10 次触发一次
    for (let i = 0; i < 20; i++) {
      selectedProviders.push(selectRoutingTarget(config, 'hash', 'hash-probe-stability-test-1', hashKey)?.provider);
    }

    const firstProvider = selectedProviders[0];
    expect(firstProvider).toBeTruthy();
    expect(selectedProviders.every(p => p === firstProvider)).toBe(true);
  } finally {
    (circuitBreaker as any).config.timeout = originalTimeout;
    (circuitBreaker as any).config.halfOpenMaxAttempts = originalHalfOpenMaxAttempts;
    circuitBreaker.resetAll();
  }
});

test('affinity mode does not drift target when probe mechanism is triggered', async () => {
  circuitBreaker.resetAll();

  const originalTimeout = (circuitBreaker as any).config.timeout;
  const originalHalfOpenMaxAttempts = (circuitBreaker as any).config.halfOpenMaxAttempts;

  (circuitBreaker as any).config.timeout = 1;
  // 给 HALF_OPEN 目标充足的尝试次数，避免测试期间因次数耗尽导致重试
  (circuitBreaker as any).config.halfOpenMaxAttempts = 100;

  try {
    const config: RoutingConfig = {
      strategy: { mode: 'affinity', affinityTTL: 60_000 },
      targets: [
        { provider: 'provider-a' },
        { provider: 'provider-b' },
      ],
    };

    // 让 provider-b 进入 OPEN 状态（后续可能进入 HALF_OPEN）
    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b down'));
    circuitBreaker.recordFailure(getTargetKey(config.targets[1]!), new Error('provider-b still down'));
    await new Promise(resolve => setTimeout(resolve, 20));

    const sessionId = 'stable-session-456';
    const selectedProviders: (string | undefined)[] = [];

    // 发起 20 次请求，probe 机制每 10 次触发一次
    for (let i = 0; i < 20; i++) {
      selectedProviders.push(selectRoutingTarget(config, 'affinity', 'affinity-probe-stability-test-1', sessionId)?.provider);
    }

    const firstProvider = selectedProviders[0];
    expect(firstProvider).toBeTruthy();
    expect(selectedProviders.every(p => p === firstProvider)).toBe(true);
  } finally {
    (circuitBreaker as any).config.timeout = originalTimeout;
    (circuitBreaker as any).config.halfOpenMaxAttempts = originalHalfOpenMaxAttempts;
    circuitBreaker.resetAll();
  }
});

describe('shouldRetrySmartRouting', () => {
  it.each([401, 403, 429, 472, 500, 502, 503, 504])('retries cross-target for upstream/transient/auth status %i', statusCode => {
    expect(shouldRetrySmartRouting(statusCode)).toBe(true);
  });

  it.each([400, 404])('does not replay invalid client request status %i to every target', statusCode => {
    expect(shouldRetrySmartRouting(statusCode)).toBe(false);
  });

  it.each([200, 201, 301, 402, 418, 422])('does not retry non-eligible status %i', statusCode => {
    expect(shouldRetrySmartRouting(statusCode)).toBe(false);
  });
});

describe('PR-4 per-request routing strategy', () => {
  describe('normalizeRoutingStrategy', () => {
    it('accepts known values case-insensitively and maps single to default', () => {
      expect(normalizeRoutingStrategy('default')).toBe('default');
      expect(normalizeRoutingStrategy('Price')).toBe('price');
      expect(normalizeRoutingStrategy(' throughput ')).toBe('throughput');
      expect(normalizeRoutingStrategy('LATENCY')).toBe('latency');
      expect(normalizeRoutingStrategy('single')).toBe('default');
    });

    it('rejects unknown / non-string values', () => {
      expect(normalizeRoutingStrategy('cheapest')).toBeNull();
      expect(normalizeRoutingStrategy('')).toBeNull();
      expect(normalizeRoutingStrategy(42)).toBeNull();
      expect(normalizeRoutingStrategy(undefined)).toBeNull();
    });
  });

  describe('extractRequestRoutingStrategy', () => {
    it('prefers body.routing over the x-gateway-routing header', () => {
      const strategy = extractRequestRoutingStrategy({
        body: { routing: 'price' },
        headers: { 'x-gateway-routing': 'latency' },
      });
      expect(strategy).toBe('price');
    });

    it('falls back to the header (case-insensitive name), ignoring invalid values', () => {
      expect(extractRequestRoutingStrategy({
        body: {},
        headers: { 'X-Gateway-Routing': 'throughput' },
      })).toBe('throughput');
      expect(extractRequestRoutingStrategy({
        body: { routing: 'nope' },
        headers: { 'x-gateway-routing': 'bogus' },
      })).toBeNull();
      expect(extractRequestRoutingStrategy({ body: {} })).toBeNull();
    });
  });

  it('routing_configs default is only representable as default', () => {
    expect(resolveConfigDefaultStrategy({ strategy: { mode: 'loadbalance' }, targets: [] })).toBe('default');
    expect(resolveConfigDefaultStrategy(undefined)).toBe('default');
  });

  describe('computeBlendedPrice', () => {
    it('shares blended price with expert bands and prices unknown costs last', () => {
      expect(computeBlendedPrice({ input_cost_per_token: 2, output_cost_per_token: 4 })).toBeCloseTo(2.5);
      expect(computeBlendedPrice({ input_cost_per_token: 2 })).toBe(Infinity);
      expect(computeBlendedPrice({ input_cost_per_token: '1', output_cost_per_token: '3' })).toBeCloseTo(1.5);
      expect(computeBlendedPrice(null)).toBe(Infinity);
    });
  });

  describe('sortTargetsForStrategy', () => {
    const targets = [
      { provider: 'a', override_params: { model: 'm-a' } },
      { provider: 'b', override_params: { model: 'm-b' } },
      { provider: 'c', override_params: { model: 'm-c' } },
    ];
    const keys = ['a::m-a', 'b::m-b', 'c::m-c'];

    it('sorts by blended price ascending', () => {
      const metrics = new Map([
        [keys[0], { blendedPrice: 3 }],
        [keys[1], { blendedPrice: 1 }],
        [keys[2], { blendedPrice: 2 }],
      ]);
      expect(sortTargetsForStrategy(targets, 'price', metrics).map(t => t.provider))
        .toEqual(['b', 'c', 'a']);
    });

    it('sorts by throughput descending', () => {
      const metrics = new Map([
        [keys[0], { avgSpeed: 10 }],
        [keys[1], { avgSpeed: 90 }],
        [keys[2], { avgSpeed: 50 }],
      ]);
      expect(sortTargetsForStrategy(targets, 'throughput', metrics).map(t => t.provider))
        .toEqual(['b', 'c', 'a']);
    });

    it('sorts by latency ascending', () => {
      const metrics = new Map([
        [keys[0], { avgTffbMs: 200 }],
        [keys[1], { avgTffbMs: 50 }],
      ]);
      const sorted = sortTargetsForStrategy(targets, 'latency', metrics);
      expect(sorted[0].provider).toBe('b');
      // missing sample keeps original relative order after sampled targets
      expect(sorted.map(t => t.provider)).toEqual(['b', 'a', 'c']);
    });

    it('returns original order when no samples exist or strategy is default', () => {
      expect(sortTargetsForStrategy(targets, 'price', new Map()).map(t => t.provider))
        .toEqual(['a', 'b', 'c']);
      expect(sortTargetsForStrategy(targets, 'default', new Map([
        [keys[0], { blendedPrice: 1 }],
      ])).map(t => t.provider)).toEqual(['a', 'b', 'c']);
    });

    it('matches no-override targets through the request model key', () => {
      const mixed = [{ provider: 'a' }, { provider: 'b', override_params: { model: 'm-b' } }];
      const metrics = new Map([
        ['a::shared', { avgSpeed: 90 }],
        ['b::m-b', { avgSpeed: 10 }],
      ]);
      expect(sortTargetsForStrategy(mixed, 'throughput', metrics, 'shared').map(t => t.provider))
        .toEqual(['a', 'b']);
      // without a request model the no-override target has no sample and sorts last
      expect(sortTargetsForStrategy(mixed, 'throughput', metrics, undefined).map(t => t.provider))
        .toEqual(['b', 'a']);
    });
  });

  describe('selectRoutingTarget with explicit strategy', () => {
    it('picks the deterministic cheapest target instead of round-robin', () => {
      circuitBreaker.resetAll();
      const config: RoutingConfig = {
        strategy: { mode: 'loadbalance' },
        targets: [
          { provider: 'expensive', override_params: { model: 'm' } },
          { provider: 'cheap', override_params: { model: 'm' } },
          { provider: 'mid', override_params: { model: 'm' } },
        ],
      };
      const metrics = new Map([
        ['expensive::m', { blendedPrice: 9 }],
        ['cheap::m', { blendedPrice: 1 }],
        ['mid::m', { blendedPrice: 5 }],
      ]);
      const selected = [
        selectRoutingTarget(config, 'loadbalance', 'pr4-price-test', undefined, undefined, 'price', metrics)?.provider,
        selectRoutingTarget(config, 'loadbalance', 'pr4-price-test', undefined, undefined, 'price', metrics)?.provider,
      ];
      expect(selected).toEqual(['cheap', 'cheap']);
    });

    it('still respects the circuit-breaker health floor when sorting', () => {
      circuitBreaker.resetAll();
      const config: RoutingConfig = {
        strategy: { mode: 'loadbalance' },
        targets: [
          { provider: 'cheap-but-open', override_params: { model: 'm' } },
          { provider: 'healthy', override_params: { model: 'm' } },
        ],
      };
      const metrics = new Map([
        ['cheap-but-open::m', { blendedPrice: 1 }],
        ['healthy::m', { blendedPrice: 5 }],
      ]);
      // Force the cheapest target's circuit open.
      const originalTimeout = (circuitBreaker as any).config.timeout;
      (circuitBreaker as any).config.timeout = 60_000;
      try {
        circuitBreaker.recordFailure('cheap-but-open::m');
        circuitBreaker.recordFailure('cheap-but-open::m'); // reach failureThreshold (2)
        const target = selectRoutingTarget(
          config, 'loadbalance', 'pr4-health-floor-test', undefined, undefined, 'price', metrics
        );
        expect(target?.provider).toBe('healthy');
      } finally {
        (circuitBreaker as any).config.timeout = originalTimeout;
        circuitBreaker.resetAll();
      }
    });

    it('routes a no-override target by its request-model metric', () => {
      circuitBreaker.resetAll();
      const config: RoutingConfig = {
        strategy: { mode: 'fallback' },
        targets: [{ provider: 'slow' }, { provider: 'fast' }],
      };
      const metrics = new Map([
        ['slow::gpt-x', { avgTffbMs: 800 }],
        ['fast::gpt-x', { avgTffbMs: 90 }],
      ]);
      const selected = selectRoutingTarget(
        config, 'fallback', 'pr4-request-model-key', undefined, undefined, 'latency', metrics, 'gpt-x'
      );
      expect(selected?.provider).toBe('fast');
      circuitBreaker.resetAll();
    });
  });
});
