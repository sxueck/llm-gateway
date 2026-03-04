import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldBypassGatewayCache } from './path-detector.js';

test('shouldBypassGatewayCache returns true for embeddings endpoint', () => {
  assert.equal(shouldBypassGatewayCache('/v1/embeddings'), true);
});

test('shouldBypassGatewayCache returns true for responses compact endpoint', () => {
  assert.equal(shouldBypassGatewayCache('/v1/responses/compact'), true);
  assert.equal(shouldBypassGatewayCache('/V1/RESPONSES/COMPACT'), true);
});

test('shouldBypassGatewayCache returns false for chat and regular responses endpoints', () => {
  assert.equal(shouldBypassGatewayCache('/v1/chat/completions'), false);
  assert.equal(shouldBypassGatewayCache('/v1/responses'), false);
});
