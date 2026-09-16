import { describe, expect, it } from 'vitest';
import {
  computeBundleDigest,
  listPlugins,
  resolvePlugin,
  validatePluginBundle,
} from './registry.js';
import {
  CODE_SEARCH_INPUT_SCHEMA,
  CODE_SEARCH_MANIFEST,
  CODE_SEARCH_OUTPUT_SCHEMA,
  CODE_SEARCH_PROMPT_MD,
} from './code-search.js';
import {
  globToRegExp,
  isForbiddenSnapshotPath,
  isSafeSnapshotPath,
} from '@llm-gateway/shared';

function validBundle() {
  return {
    manifest: JSON.parse(JSON.stringify(CODE_SEARCH_MANIFEST)),
    files: {
      'prompt.md': CODE_SEARCH_PROMPT_MD,
      'input.schema.json': JSON.stringify(CODE_SEARCH_INPUT_SCHEMA, null, 2),
      'output.schema.json': JSON.stringify(CODE_SEARCH_OUTPUT_SCHEMA, null, 2),
    },
  };
}

describe('plugin registry', () => {
  it('registers the built-in code-search fixture and resolves a stable digest', () => {
    const plugins = listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.id).toBe('com.llm-gateway.code-search');

    const resolved = resolvePlugin('com.llm-gateway.code-search', '1.0.0');
    expect(resolved).toBeDefined();
    expect(resolved!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeBundleDigest(resolved!)).toBe(resolved!.digest);
  });

  it('rejects unknown plugin versions', () => {
    expect(resolvePlugin('com.llm-gateway.code-search', '9.9.9')).toBeUndefined();
    expect(resolvePlugin('com.example.other', '1.0.0')).toBeUndefined();
  });

  it('accepts the pristine bundle', () => {
    expect(validatePluginBundle(validBundle())).toEqual([]);
  });

  it('rejects path traversal in role file references', () => {
    const b = validBundle();
    (b.manifest.role as any).system_prompt = '../../etc/passwd';
    expect(validatePluginBundle(b).join(' ')).toContain('unsafe or unknown bundle file reference');
  });

  it('rejects role references to files missing from the bundle', () => {
    const b = validBundle();
    delete (b.files as Record<string, string | undefined>)['prompt.md'];
    expect(validatePluginBundle(b).join(' ')).toContain('referenced file "prompt.md" missing');
  });

  it('rejects tools outside the platform allowlist', () => {
    const b = validBundle();
    b.manifest.tool_policy.allow = ['grep_search', 'bash'];
    expect(validatePluginBundle(b).join(' ')).toContain('tools not offered by the platform');
  });

  it('rejects workspace roots escaping /workspace', () => {
    const b = validBundle();
    b.manifest.workspace_policy.allowed_roots = ['/etc'];
    expect(validatePluginBundle(b).join(' ')).toContain('escapes the platform workspace root');
  });

  it('rejects output schemas missing mandatory top-level or per-file fields', () => {
    const b = validBundle();
    const schema = JSON.parse(b.files['output.schema.json']);
    delete schema.required;
    b.files['output.schema.json'] = JSON.stringify(schema);
    const errors = validatePluginBundle(b).join(' ');
    expect(errors).toContain('output schema must require "status"');

    const b2 = validBundle();
    const schema2 = JSON.parse(b2.files['output.schema.json']);
    delete schema2.properties.files.items.required;
    b2.files['output.schema.json'] = JSON.stringify(schema2);
    expect(validatePluginBundle(b2).join(' ')).toContain('file items must require "path"');
  });

  it('rejects bundles carrying executable files', () => {
    const b: any = validBundle();
    b.files['index.ts'] = 'export {}';
    expect(validatePluginBundle(b).join(' ')).toContain('outside the allowed set');
  });
});

describe('snapshot path guards', () => {
  it('accepts normal relative paths', () => {
    for (const p of [
      'packages/backend/src/index.ts',
      '.github/workflows/ci.yml',
      'a/b/c/d/e.txt',
      'README.md',
    ]) {
      expect(isSafeSnapshotPath(p)).toBe(true);
    }
  });

  it('rejects traversal, absolute, and malformed paths', () => {
    for (const p of [
      '../escape.txt',
      'a/../../escape.txt',
      '/etc/passwd',
      'C:\\win.txt',
      'a//b',
      'a/./b',
      'a/b/',
      '',
    ]) {
      expect(isSafeSnapshotPath(p)).toBe(false);
    }
  });

  it('glob translation matches full paths and basenames', () => {
    expect(globToRegExp('*.key').test('server.key')).toBe(true);
    expect(globToRegExp('*.key').test('a/b/server.key')).toBe(false);
    expect(globToRegExp('.env.*').test('.env.local')).toBe(true);
    expect(globToRegExp('dist/**').test('dist/a/b.js')).toBe(true);
    expect(globToRegExp('.git/**').test('.git/config')).toBe(true);
    expect(globToRegExp('.git/**').test('.gitx/config')).toBe(false);
    expect(globToRegExp('node_modules/**').test('node_modules/pkg/index.js')).toBe(true);
  });

  it('blocks platform-forbidden paths while allowing regular sources', () => {
    for (const p of [
      '.env',
      '.env.production',
      '.git/config',
      'node_modules/foo/index.js',
      'dist/bundle.js',
      'server.pem',
      'id_rsa',
      'credentials.json',
      'auth.json',
    ]) {
      expect(isForbiddenSnapshotPath(p)).toBe(true);
    }
    expect(isForbiddenSnapshotPath('packages/backend/src/index.ts')).toBe(false);
    expect(isForbiddenSnapshotPath('src/auth.json.spec.ts')).toBe(false);
  });
});
