import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildVirtualKeyCurlSnippets,
  shellSingleQuote,
} from './curl-snippet';

describe('shellSingleQuote', () => {
  it('wraps plain values without extra escaping', () => {
    expect(shellSingleQuote('sk-live_abc-123')).toBe("'sk-live_abc-123'");
  });

  it('terminates and reopens the quote around embedded single quotes', () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
  });

  it('keeps command substitution, variable expansion and backticks inert inside the quotes', () => {
    // The sequences stay literal inside single quotes; the shell never expands them.
    expect(shellSingleQuote("$(rm -rf /)`id`${HOME}")).toBe("'$(rm -rf /)`id`${HOME}'");
  });
});

describe('buildVirtualKeyCurlSnippets', () => {
  const base = {
    baseUrl: 'https://gw.example.com/',
    keyValue: "k'$(reboot)",
    modelIdentifier: 'anthropic/claude-sonnet-4',
  };

  it('returns null when no usable model identifier is bound', () => {
    expect(buildVirtualKeyCurlSnippets({ ...base, modelIdentifier: '' })).toBeNull();
  });

  it('strips trailing slashes from the base url', () => {
    const snippets = buildVirtualKeyCurlSnippets(base)!;
    expect(snippets.openai).toContain("'https://gw.example.com/v1/chat/completions'");
    expect(snippets.anthropic).toContain("'https://gw.example.com/v1/messages'");
  });

  it('uses the model identifier (not the display name) inside the JSON body', () => {
    const snippets = buildVirtualKeyCurlSnippets(base)!;
    expect(snippets.openai).toContain(
      `'${JSON.stringify({ model: 'anthropic/claude-sonnet-4', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 })}'`,
    );
  });

  it('shell-quotes headers carrying the key so nothing is interpolated by the shell', () => {
    const snippets = buildVirtualKeyCurlSnippets(base)!;
    expect(snippets.openai).toContain(`  -H 'Authorization: Bearer k'\\''$(reboot)' \\`);
    expect(snippets.anthropic).toContain(`  -H 'x-api-key: k'\\''$(reboot)' \\`);
    expect(snippets.anthropic).toContain(`  -H 'anthropic-version: 2023-06-01' \\`);
  });

  it('keeps every line except the last continuable and the payload on the final line', () => {
    const snippets = buildVirtualKeyCurlSnippets(base)!;
    for (const cmd of [snippets.openai, snippets.anthropic]) {
      const lines = cmd.split('\n');
      expect(lines[0].startsWith('curl -X POST ')).toBe(true);
      for (const line of lines.slice(0, -1)) {
        expect(line.endsWith(' \\')).toBe(true);
      }
      expect(lines.at(-1)!.startsWith('  -d ')).toBe(true);
    }
  });
});

/**
 * Behavior test: execute the generated command in a real bash with a stub
 * `curl` on PATH and assert exactly one invocation carrying the URL and every
 * argument verbatim. Without the line continuation on the first line the shell
 * runs `curl` with only the URL and then fails on the following lines, so this
 * test fails on that regression (and on any quoting hole that lets the shell
 * split or expand arguments).
 */
const canRunBash = existsSync('/bin/bash');

describe.skipIf(!canRunBash)('buildVirtualKeyCurlSnippets under a real bash', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vk-curl-'));
    const stub = [
      '#!/bin/sh',
      'printf "CALL\\n" >> "$CURL_LOG"',
      'for arg in "$@"; do printf "%s\\n" "$arg" >> "$CURL_LOG"; done',
      'exit 0',
    ].join('\n');
    writeFileSync(join(dir, 'curl'), stub, { mode: 0o755 });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function execInBash(command: string, logFile: string): void {
    execFileSync('bash', ['-c', command], {
      cwd: dir,
      env: {
        PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        CURL_LOG: logFile,
        HOME: dir,
      },
    });
  }

  function readLog(logFile: string): string[] {
    return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.length > 0);
  }

  it('invokes curl exactly once with the URL, headers and body as separate verbatim arguments', () => {
    const keyValue = "k'$(reboot)`id`";
    const snippets = buildVirtualKeyCurlSnippets({
      baseUrl: 'https://gw.example.com',
      keyValue,
      modelIdentifier: 'anthropic/claude-sonnet-4',
    })!;

    for (const [protocol, cmd] of [
      ['openai', snippets.openai],
      ['anthropic', snippets.anthropic],
    ] as const) {
      const logFile = join(dir, `args-${protocol}.log`);
      rmSync(logFile, { force: true });
      // A quoting hole would let the shell execute $(reboot) / `id` here.
      execInBash(cmd, logFile);
      const log = readLog(logFile);
      const calls = log.filter((line) => line === 'CALL');
      expect(calls, `${protocol}: exactly one curl invocation`).toHaveLength(1);
      const args = log.filter((line) => line !== 'CALL');
      expect(args.slice(0, 3)).toEqual([
        '-X',
        'POST',
        `https://gw.example.com/v1/${protocol === 'openai' ? 'chat/completions' : 'messages'}`,
      ]);
      expect(args).toContain('Content-Type: application/json');
      // The hostile characters survive as literal text in a single argument, unexpanded.
      expect(args).toContain(
        protocol === 'openai' ? `Authorization: Bearer ${keyValue}` : `x-api-key: ${keyValue}`,
      );
      if (protocol === 'anthropic') {
        expect(args).toContain('anthropic-version: 2023-06-01');
      }
      const dataIdx = args.indexOf('-d');
      expect(dataIdx).toBeGreaterThan(-1);
      const body = JSON.parse(args[dataIdx + 1]);
      expect(body.model).toBe('anthropic/claude-sonnet-4');
    }
  });

  it('a first line without the continuation is detected as broken (regression guard)', () => {
    const snippets = buildVirtualKeyCurlSnippets({
      baseUrl: 'https://gw.example.com',
      keyValue: 'k',
      modelIdentifier: 'm',
    })!;
    const broken = snippets.openai.replace(' \\\n', '\n');
    expect(broken).not.toBe(snippets.openai);

    const logFile = join(dir, 'args-broken.log');
    rmSync(logFile, { force: true });
    try {
      execInBash(broken, logFile);
    } catch {
      // bash reports the orphaned continuation lines as failed commands — expected here
    }
    const log = existsSync(logFile) ? readLog(logFile) : [];
    // The broken form can never deliver the full argument set in one invocation.
    const complete =
      log.filter((line) => line === 'CALL').length === 1 && log.includes('Content-Type: application/json');
    expect(complete).toBe(false);
  });
});
