import { describe, expect, it } from 'vitest';
import { decryptBlob, encryptBlob } from './encryption.js';

describe('snapshot encryption', () => {
  it('round-trips AES-GCM ciphertext and rejects a truncated envelope', () => {
    const key = Buffer.alloc(32, 1);
    const plaintext = Buffer.from('snapshot content');

    expect(decryptBlob(key, encryptBlob(key, plaintext))).toEqual(plaintext);
    expect(() => decryptBlob(key, Buffer.alloc(27))).toThrow(
      'invalid AES-GCM envelope',
    );
  });
});
