import { test, expect } from 'vitest';

import { shouldBypassGatewayCache, isImagesPath, detectEndpointType, EndpointType } from './path-detector.js';

const bypassCases: Array<[string, boolean]> = [
  ['/v1/embeddings', true],
  ['/v1/responses/compact', true],
  ['/V1/RESPONSES/COMPACT', true],
  ['/v1/chat/completions', false],
  ['/v1/responses', false],
  ['/v1/images/generations', true],
  ['/images/generations', true],
  ['/v1/images/edits', true],
];
test('shouldBypassGatewayCache returns the expected result per path', () => {
  for (const [path, expected] of bypassCases) {
    expect(shouldBypassGatewayCache(path)).toBe(expected);
  }
});

const imagesCases: Array<[string, boolean, EndpointType | undefined]> = [
  ['/v1/images/generations', true, EndpointType.IMAGES],
  ['/images/generations', true, EndpointType.IMAGES],
  ['/v1/images/edits', true, EndpointType.IMAGES],
  ['/v1/images/variations', true, EndpointType.IMAGES],
  ['/v1/chat/completions', false, undefined],
  ['/v1/embeddings', false, undefined],
  ['/v1/responses', false, undefined],
];
test('isImagesPath/detectEndpointType return the expected result per path', () => {
  for (const [path, isImages, endpointType] of imagesCases) {
    expect(isImagesPath(path)).toBe(isImages);
    if (endpointType !== undefined) {
      expect(detectEndpointType(path)).toBe(endpointType);
    }
  }
});
