// Regression tests for the shared snapshot-forbidden glob matching. They live in
// worker (not shared) because only the worker package has a vitest setup; shared
// is consumed as raw TS. Exact matching semantics of globToRegExp must stay
// stable because packages/backend depends on them (see backend registry tests).
import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_FORBIDDEN_PATH_GLOBS,
  globToRegExp,
  isForbiddenSnapshotPath,
} from '@llm-gateway/shared';

describe('globToRegExp', () => {
  it('anchors to full matches and keeps * from crossing path separators', () => {
    expect(globToRegExp('*.key').test('server.key')).toBe(true);
    expect(globToRegExp('*.key').test('a/b/server.key')).toBe(false);
    expect(globToRegExp('.env.*').test('.env.local')).toBe(true);
    expect(globToRegExp('.env.*').test('env.local')).toBe(false);
    expect(globToRegExp('dist/**').test('dist/a/b.js')).toBe(true);
    expect(globToRegExp('.git/**').test('.git/config')).toBe(true);
    expect(globToRegExp('.git/**').test('.gitx/config')).toBe(false);
  });
});

describe('isForbiddenSnapshotPath (precompiled platform globs)', () => {
  it('matches every forbidden shape at the repo root', () => {
    for (const p of [
      '.env',
      '.env.production',
      '.git/config',
      'node_modules/pkg/x.js',
      'dist/bundle.js',
      'build/out.js',
      'coverage/lcov.info',
      'server.pem',
      'server.key',
      'cert.p12',
      'cert.crt',
      'id_rsa',
      'id_rsa.pub',
      'credentials.json',
      'credentials',
      'auth.json',
    ]) {
      expect(isForbiddenSnapshotPath(p), p).toBe(true);
    }
  });

  it('matches forbidden segments at any depth via suffix semantics', () => {
    for (const p of [
      'apps/web/.env',
      'a/b/c/node_modules/d/e.js',
      'packages/backend/dist/index.js',
      'deep/nested/build/static/app.css',
      'ssh/keys/id_rsa',
      'config/credentials.yaml',
    ]) {
      expect(isForbiddenSnapshotPath(p), p).toBe(true);
    }
  });

  it('does not flag lookalike safe paths', () => {
    for (const p of [
      'src/env.ts',
      'env.example',
      '.envrc',
      'notes.env',
      'README.md',
      'src/auth.ts',
      'auth.json.spec.ts',
      'authentication.json',
      'packages/backend/src/index.ts',
    ]) {
      expect(isForbiddenSnapshotPath(p), p).toBe(false);
    }
  });

  it('normalizes backslash separators before matching', () => {
    expect(isForbiddenSnapshotPath('a\\b\\node_modules\\x.js')).toBe(true);
  });

  it('covers the full exported platform list', () => {
    // Every platform glob must fire on at least one canonical fixture so a
    // precompilation mistake (e.g. a wrong regex) cannot silently disable a rule.
    const probes: Record<string, string> = {
      '.env': '.env',
      '.env.*': '.env.local',
      '.git/**': '.git/HEAD',
      'node_modules/**': 'node_modules/x.js',
      'dist/**': 'dist/x.js',
      'build/**': 'build/x.js',
      'coverage/**': 'coverage/x.info',
      '*.pem': 'a.pem',
      '*.key': 'a.key',
      '*.p12': 'a.p12',
      '*.crt': 'a.crt',
      'id_rsa': 'id_rsa',
      'id_rsa.*': 'id_rsa.pub',
      'credentials*': 'credentials.json',
      'auth.json': 'auth.json',
    };
    for (const glob of SNAPSHOT_FORBIDDEN_PATH_GLOBS) {
      expect(probes[glob], glob).toBeDefined();
      expect(isForbiddenSnapshotPath(probes[glob]), glob).toBe(true);
    }
  });

  it('is stable across repeated calls (precompiled matchers stay stateless)', () => {
    expect(isForbiddenSnapshotPath('node_modules/a.js')).toBe(true);
    expect(isForbiddenSnapshotPath('node_modules/a.js')).toBe(true);
    expect(isForbiddenSnapshotPath('src/a.ts')).toBe(false);
    expect(isForbiddenSnapshotPath('src/a.ts')).toBe(false);
  });
});
