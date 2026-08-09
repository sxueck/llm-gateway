import { describe, expect, test } from 'vitest';
import { parseNpy } from './npy-parser.js';

// Build a minimal valid .npy buffer (little-endian float32) for testing.
function buildNpy(shape: number[], values: number[], dtype = '<f4'): Buffer {
  const headerDict = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape.join(', ')},), }`;
  // v1 header: 6-byte magic + 2-byte version + 2-byte header-len (little-endian),
  // padded with spaces so total (10 + header.length) is a multiple of 64.
  let header = headerDict;
  const fixedOverhead = 10; // magic(6) + version(2) + headerLen(2)
  while ((fixedOverhead + header.length) % 64 !== 0) {
    header += ' ';
  }
  const headerBuf = Buffer.from(header, 'latin1');
  const pre = Buffer.alloc(10);
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]).copy(pre, 0); // magic
  pre.writeUInt8(1, 6); // major version
  pre.writeUInt8(0, 7); // minor version
  pre.writeUInt16LE(headerBuf.length, 8);

  const bytesPerValue = dtype === '<f8' ? 8 : 4;
  const dataBuf = Buffer.alloc(values.length * bytesPerValue);
  values.forEach((v, i) => {
    if (dtype === '<f8') dataBuf.writeDoubleLE(v, i * 8);
    else dataBuf.writeFloatLE(v, i * 4);
  });

  return Buffer.concat([pre, headerBuf, dataBuf]);
}

describe('parseNpy', () => {
  test('parses a float32 1-D intercept array', () => {
    const buf = buildNpy([3], [0.5, -1.25, 2.0]);
    const arr = parseNpy(buf);
    expect(arr.shape).toEqual([3]);
    expect(Array.from(arr.data)).toEqual([0.5, -1.25, 2.0]);
  });

  test('parses a float32 2-D coef array row-major', () => {
    const buf = buildNpy([2, 3], [1, 2, 3, 4, 5, 6]);
    const arr = parseNpy(buf);
    expect(arr.shape).toEqual([2, 3]);
    expect(Array.from(arr.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('parses float64 arrays', () => {
    const buf = buildNpy([2], [0.1, 0.2], '<f8');
    const arr = parseNpy(buf);
    expect(arr.shape).toEqual([2]);
    expect(arr.data[0]).toBeCloseTo(0.1, 6);
    expect(arr.data[1]).toBeCloseTo(0.2, 6);
  });

  test('rejects bad magic bytes', () => {
    const bad = Buffer.alloc(20, 0);
    expect(() => parseNpy(bad)).toThrow(/magic/);
  });
});
