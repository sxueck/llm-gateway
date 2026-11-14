// ast-grep 0.51 skips Vue SFCs. Keep this advisory check alongside its CSS/TS rules.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve('packages/web/src');
const color = /#[0-9a-f]{8}(?![0-9a-f])|#[0-9a-f]{6}(?![0-9a-f])|#[0-9a-f]{4}(?![0-9a-f])|#[0-9a-f]{3}(?![0-9a-f])/gi;

export function findVueHex(source, path) {
  let inChartPalette = false;
  const matches = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (path === 'views/DashboardView.vue' && /^const COLOR_PALETTE = \[$/.test(line)) inChartPalette = true;
    if (!inChartPalette) {
      for (const match of line.matchAll(color)) {
        // Vue named slots start with # and are not color literals.
        const before = line.slice(0, match.index);
        if (/<template\s+$/.test(before)) continue;
        matches.push({ line: index + 1, value: match[0] });
      }
    }
    if (inChartPalette && /^\]$/.test(line)) inChartPalette = false;
  }
  return matches;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && entry.name.endsWith('.vue')) files.push(path);
  }
  return files;
}

async function main() {
  let count = 0;
  for (const path of await walk(root)) {
    const rel = relative(root, path).replaceAll('\\', '/');
    for (const item of findVueHex(await readFile(path, 'utf8'), rel)) {
      console.warn(`warning[no-bare-hex-color-vue]: ${rel}:${item.line} ${item.value}`);
      count++;
    }
  }
  console.log(`Vue hex color warnings: ${count} (Dashboard COLOR_PALETTE excluded)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
