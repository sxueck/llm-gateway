import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(path.join(__dirname, 'check-i18n-keys.cjs'), 'utf8');

function check(source: string, locales: Record<string, object>) {
  const written = new Map<string, string>();
  const logs: string[] = [];
  const process = { cwd: () => '/fixture', exitCode: 0 };
  const fs = {
    readFileSync: (file: string) => {
      const locale = Object.keys(locales).find(name => file.endsWith(`/locales/${name}.ts`));
      return locale ? `export default ${JSON.stringify(locales[locale])}` : source;
    },
    writeFileSync: (file: string, content: string) => written.set(file, content),
  };
  runInNewContext(script, {
    process,
    console: { log: (...args: unknown[]) => logs.push(args.join(' ')) },
    require: (name: string) => {
      if (name === 'fs') return fs;
      if (name === 'path') return path;
      const content = written.get(name);
      if (content === undefined) throw new Error(`Unexpected require: ${name}`);
      const module = { exports: {} };
      runInNewContext(content, { module });
      return module.exports;
    },
  });
  return { output: logs.join('\n'), exitCode: process.exitCode };
}

const locales = {
  'zh-CN': { providers: { present: '存在', other: '另一个' } },
  'en-US': { providers: { present: 'Present', other: 'Other' } },
};

describe('i18n key checker', () => {
  it('reports a missing ternary branch in either locale and fails the command', () => {
    const result = check("t(editing ? 'providers.present' : 'providers.other')", {
      ...locales,
      'en-US': { providers: { present: 'Present' } },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('en-US: providers.other');
    expect(result.output).not.toContain('zh-CN: providers.other');
  });

  it('accepts existing branches without treating dynamic prefixes or unrelated strings as keys', () => {
    const result = check(
      `t(editing ? 'providers.present' : 'providers.other'); const prefix = 'providers.'; const url = 'api.example.com';
       <n-badge :value="providers.length" />`,
      locales,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ALL I18N KEYS RESOLVE');
  });

  it('checks double-quoted ternary branches too', () => {
    const result = check('t(editing ? "providers.present" : "providers.missing")', locales);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('en-US: providers.missing');
  });

  it('still reports missing literal translation keys', () => {
    const result = check("t('providers.missing')", locales);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('zh-CN: providers.missing');
    expect(result.output).toContain('en-US: providers.missing');
  });
});
