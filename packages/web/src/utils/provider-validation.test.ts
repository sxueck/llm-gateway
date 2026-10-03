import { describe, expect, it } from 'vitest';
import { validateOwnerNode } from './provider-validation';

describe('validateOwnerNode', () => {
  it('treats empty value as valid (default control node)', () => {
    expect(validateOwnerNode('')).toEqual({ isValid: true });
    expect(validateOwnerNode('   ')).not.toEqual({ isValid: true });
  });

  it('accepts valid node identifiers', () => {
    expect(validateOwnerNode('node-a').isValid).toBe(true);
    expect(validateOwnerNode('a').isValid).toBe(true);
    expect(validateOwnerNode('a'.repeat(32)).isValid).toBe(true);
    expect(validateOwnerNode('node-01').isValid).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(validateOwnerNode('Node').isValid).toBe(false); // uppercase
    expect(validateOwnerNode('1node').isValid).toBe(false); // starts with digit
    expect(validateOwnerNode('-node').isValid).toBe(false); // starts with hyphen
    expect(validateOwnerNode('node_x').isValid).toBe(false); // underscore
    expect(validateOwnerNode('a'.repeat(33)).isValid).toBe(false); // too long
  });
});
