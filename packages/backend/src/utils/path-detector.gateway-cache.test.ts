import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldBypassGatewayCache, isImagesPath, detectEndpointType, EndpointType } from './path-detector.js';

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

test('shouldBypassGatewayCache returns true for images endpoints', () => {
  assert.equal(shouldBypassGatewayCache('/v1/images/generations'), true);
  assert.equal(shouldBypassGatewayCache('/images/generations'), true);
  assert.equal(shouldBypassGatewayCache('/v1/images/edits'), true);
});

test('isImagesPath returns true for images endpoints', () => {
  assert.equal(isImagesPath('/v1/images/generations'), true);
  assert.equal(isImagesPath('/images/generations'), true);
  assert.equal(isImagesPath('/v1/images/edits'), true);
  assert.equal(isImagesPath('/v1/images/variations'), true);
});

test('isImagesPath returns false for non-images endpoints', () => {
  assert.equal(isImagesPath('/v1/chat/completions'), false);
  assert.equal(isImagesPath('/v1/embeddings'), false);
  assert.equal(isImagesPath('/v1/responses'), false);
});

test('detectEndpointType returns IMAGES for images paths', () => {
  assert.equal(detectEndpointType('/v1/images/generations'), EndpointType.IMAGES);
  assert.equal(detectEndpointType('/images/edits'), EndpointType.IMAGES);
  assert.equal(detectEndpointType('/v1/images/variations'), EndpointType.IMAGES);
});
