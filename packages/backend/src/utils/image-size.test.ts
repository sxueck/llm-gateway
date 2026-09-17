import { describe, expect, test } from 'vitest';
import { detectImageSizeMismatch, parsePngDimensions } from './image-size.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngHeaderBase64(width: number, height: number): string {
  const header = Buffer.concat([
    PNG_SIGNATURE,
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    Buffer.alloc(4),
    Buffer.alloc(4),
  ]);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString('base64');
}

describe('parsePngDimensions', () => {
  test('reads IHDR width/height from a base64 PNG header', () => {
    expect(parsePngDimensions(pngHeaderBase64(1536, 1024))).toEqual({
      width: 1536,
      height: 1024,
    });
  });

  test('returns null for non-PNG base64', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]).toString('base64');
    expect(parsePngDimensions(jpeg)).toBeNull();
  });

  test('returns null for empty or truncated input', () => {
    expect(parsePngDimensions('')).toBeNull();
    expect(parsePngDimensions(pngHeaderBase64(10, 10).slice(0, 8))).toBeNull();
  });
});

describe('detectImageSizeMismatch', () => {
  const data = (b64: string) => [{ b64_json: b64 }];

  test('returns null when actual size matches request', () => {
    expect(detectImageSizeMismatch('1024x1024', data(pngHeaderBase64(1024, 1024)))).toBeNull();
  });

  test('reports mismatch when upstream returned a different size', () => {
    expect(detectImageSizeMismatch('768x512', data(pngHeaderBase64(1536, 1024)))).toEqual({
      requested: '768x512',
      actual: '1536x1024',
    });
  });

  test('skips non-WxH sizes', () => {
    expect(detectImageSizeMismatch('auto', data(pngHeaderBase64(1536, 1024)))).toBeNull();
    expect(detectImageSizeMismatch('abc', data(pngHeaderBase64(1536, 1024)))).toBeNull();
    expect(detectImageSizeMismatch(undefined, data(pngHeaderBase64(1536, 1024)))).toBeNull();
  });

  test('skips payloads without b64_json (url-style responses)', () => {
    expect(detectImageSizeMismatch('768x512', [{ url: 'https://example.com/x.png' }])).toBeNull();
  });

  test('skips empty or malformed data', () => {
    expect(detectImageSizeMismatch('768x512', [])).toBeNull();
    expect(detectImageSizeMismatch('768x512', undefined)).toBeNull();
    expect(detectImageSizeMismatch('768x512', data('not-a-png'))).toBeNull();
  });
});
