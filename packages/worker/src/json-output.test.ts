import { describe, expect, it } from 'vitest';
import { extractJson, lightValidateResult } from './json-output.js';

describe('extractJson', () => {
  it('parses direct JSON', () => {
    const r = extractJson('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1 });
  });

  it('parses fenced json blocks', () => {
    const r = extractJson('Here you go:\n```json\n{"summary": "x", "files": []}\n```\nmore text');
    expect(r.ok).toBe(true);
  });

  it('parses the first balanced object in prose', () => {
    const r = extractJson('Result: {"files": [{"path":"a.ts"}]} trailing');
    expect(r.ok).toBe(true);
  });

  it('fails when no object exists', () => {
    expect(extractJson('no json here').ok).toBe(false);
  });

  it('handles braces inside strings', () => {
    const r = extractJson('{"summary": "brace } inside"}');
    expect(r.ok).toBe(true);
  });
});

describe('lightValidateResult', () => {
  const base = {
    status: 'completed',
    summary: 'ok',
    files: [{ path: 'a.ts', start_line: 1, end_line: 5, reason: 'r' }],
  };

  it('accepts a valid result', () => {
    expect(lightValidateResult(base)).toEqual([]);
  });

  it('requires summary and files', () => {
    expect(lightValidateResult({ status: 'completed' }).join(' ')).toContain('summary');
    expect(lightValidateResult({ ...base, files: 'x' }).join(' ')).toContain('files');
  });

  it('rejects absolute or traversing paths', () => {
    const errors = lightValidateResult({
      ...base,
      files: [{ path: '/etc/passwd', start_line: 1, end_line: 2, reason: 'r' }],
    });
    expect(errors.join(' ')).toContain('workspace-relative');
  });

  it('rejects inverted line ranges', () => {
    const errors = lightValidateResult({
      ...base,
      files: [{ path: 'a.ts', start_line: 10, end_line: 2, reason: 'r' }],
    });
    expect(errors.join(' ')).toContain('end_line');
  });
});
