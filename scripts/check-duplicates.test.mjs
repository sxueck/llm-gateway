import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { changedFiles, relevantDuplicates } from './check-duplicates.mjs';

test('filters clones by either file without losing their counterpart', () => {
  const clones = [
    { firstFile: { name: 'a.ts' }, secondFile: { name: 'b.ts' } },
    { firstFile: { name: 'c.ts' }, secondFile: { name: 'd.ts' } },
  ];
  assert.deepEqual(relevantDuplicates(clones, ['b.ts']), [clones[0]]);
  assert.deepEqual(relevantDuplicates(clones, ['missing.ts']), []);
});

test('finds staged, unstaged and untracked files, excluding ignored and deleted files', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'duplicate-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    writeFileSync(resolve(dir, '.gitignore'), 'ignored\n');
    for (const file of ['staged', 'unstaged', 'deleted']) writeFileSync(resolve(dir, file), 'original');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    writeFileSync(resolve(dir, 'staged'), 'changed');
    git('add', 'staged');
    writeFileSync(resolve(dir, 'unstaged'), 'changed');
    writeFileSync(resolve(dir, 'untracked'), 'new');
    writeFileSync(resolve(dir, 'ignored'), 'ignored');
    rmSync(resolve(dir, 'deleted'));
    assert.deepEqual(changedFiles(dir).sort(), ['staged', 'unstaged', 'untracked']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
