import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function changedFiles(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  return [...new Set([
    ...git('diff', '--name-only', '-z', '--diff-filter=ACMRT', 'HEAD', '--'),
    ...git('ls-files', '--others', '--exclude-standard', '-z'),
  ])].filter(file => existsSync(resolve(cwd, file)));
}

export function relevantDuplicates(duplicates, files) {
  const changed = new Set(files.map(file => file.split(sep).join('/')));
  return duplicates.filter(({ firstFile, secondFile }) =>
    changed.has(firstFile.name.replaceAll('\\', '/')) || changed.has(secondFile.name.replaceAll('\\', '/')),
  );
}

function main() {
  const files = process.argv.length > 2
    ? process.argv.slice(2).map(file => relative(root, resolve(process.cwd(), file)))
    : changedFiles(root);
  if (files.some(file => file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file))) {
    throw new Error('Files must be inside the repository');
  }
  if (files.length === 0) {
    console.log('No changed files to check.');
    return;
  }
  const dir = mkdtempSync(resolve(tmpdir(), 'llm-gateway-jscpd-'));
  try {
    execFileSync(resolve(root, 'node_modules/.bin/jscpd'), [
      'packages', 'scripts', '--gitignore', '--noSymlinks', '--min-lines', '5', '--min-tokens', '50',
      '--max-lines', '100000', '--max-size', '5mb', '--format', 'typescript,javascript',
      '--reporters', 'json', '--output', dir, '--silent',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    const report = JSON.parse(readFileSync(resolve(dir, 'jscpd-report.json'), 'utf8'));
    const matches = relevantDuplicates(report.duplicates, files);
    console.log(`Duplicate fragments involving selected files: ${matches.length} (advisory; TypeScript/JavaScript only)`);
    for (const { firstFile, secondFile, lines } of matches) {
      console.log(`${firstFile.name}:${firstFile.start}-${firstFile.end} <-> ${secondFile.name}:${secondFile.start}-${secondFile.end} (${lines} lines)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
