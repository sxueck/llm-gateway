import { test, expect } from 'vitest';

import { shouldBypassGatewayCache, isImagesPath, detectEndpointType, EndpointType } from './path-detector.js';

test('shouldBypassGatewayCache returns true for embeddings endpoint', () => {
  expect(shouldBypassGatewayCache('/v1/embeddings')).toBe(true);
});

test('shouldBypassGatewayCache returns true for responses compact endpoint', () => {
  expect(shouldBypassGatewayCache('/v1/responses/compact')).toBe(true);
  expect(shouldBypassGatewayCache('/V1/RESPONSES/COMPACT')).toBe(true);
});

test('shouldBypassGatewayCache returns false for chat and regular responses endpoints', () => {
  expect(shouldBypassGatewayCache('/v1/chat/completions')).toBe(false);
  expect(shouldBypassGatewayCache('/v1/responses')).toBe(false);
});

test('shouldBypassGatewayCache returns true for images endpoints', () => {
  expect(shouldBypassGatewayCache('/v1/images/generations')).toBe(true);
  expect(shouldBypassGatewayCache('/images/generations')).toBe(true);
  expect(shouldBypassGatewayCache('/v1/images/edits')).toBe(true);
});

test('isImagesPath returns true for images endpoints', () => {
  expect(isImagesPath('/v1/images/generations')).toBe(true);
  expect(isImagesPath('/images/generations')).toBe(true);
  expect(isImagesPath('/v1/images/edits')).toBe(true);
  expect(isImagesPath('/v1/images/variations')).toBe(true);
});

test('isImagesPath returns false for non-images endpoints', () => {
  expect(isImagesPath('/v1/chat/completions')).toBe(false);
  expect(isImagesPath('/v1/embeddings')).toBe(false);
  expect(isImagesPath('/v1/responses')).toBe(false);
});

test('detectEndpointType returns IMAGES for images paths', () => {
  expect(detectEndpointType('/v1/images/generations')).toBe(EndpointType.IMAGES);
  expect(detectEndpointType('/images/edits')).toBe(EndpointType.IMAGES);
  expect(detectEndpointType('/v1/images/variations')).toBe(EndpointType.IMAGES);
});
