import test from 'node:test';
import assert from 'node:assert/strict';

import { circuitBreaker } from '../../services/circuit-breaker.js';
import { getTargetKey, hasAvailableRoutingTargets, selectRoutingTarget, type RoutingConfig } from './routing.js';

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

  assert.deepEqual(selectedProviders, ['provider-a', 'provider-b', 'provider-c', 'provider-a']);
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

  assert.equal(selectedTarget?.provider, 'provider-a');
  assert.equal(selectedTarget?.override_params?.model, 'model-2');
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

  assert.equal(firstTarget?.provider, 'provider-a');
  assert.equal(secondTarget?.provider, 'provider-b');
  assert.equal(thirdTarget?.provider, 'provider-c');
  assert.equal(fourthTarget?.provider, 'provider-a');
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

  assert.equal(hasAvailableRoutingTargets(config, excludedTargetKeys), false);
  assert.equal(selectRoutingTarget(config, 'loadbalance', 'all-targets-excluded-test-1', undefined, excludedTargetKeys), null);
});
