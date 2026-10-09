import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSearchAgent, type WorkerRunConfig } from './agent.js';
import type { WorkerPluginManifest } from '@llm-gateway/shared';

let workspace: string;

const manifest: WorkerPluginManifest = {
  schema_version: '1',
  id: 'com.llm-gateway.code-search',
  name: 'Code Search',
  version: '1.0.0',
  runtime: { kind: 'pi-worker' },
  role: { system_prompt: './prompt.md', input_schema: './input.schema.json', output_schema: './output.schema.json' },
  tool_policy: {
    allow: ['grep_search', 'read_file', 'list_directory', 'glob_files'],
    deny: [],
    max_parallel_calls: 6,
  },
  workspace_policy: {
    mode: 'read_only',
    allowed_roots: ['/workspace/repo'],
    exclude_globs: ['.env', 'node_modules/**'],
  },
  execution_policy: {
    max_turns: 4,
    timeout_seconds: 30,
    max_files_read: 20,
    max_total_read_lines: 6000,
    max_result_tokens: 4000,
  },
  model_policy: { profile: 'search-fast', allow_client_override: false },
};

interface RecordedCall {
  url: string;
  body: any;
}

function fakeFetch(script: Array<(call: RecordedCall) => Response>) {
  const calls: RecordedCall[] = [];
  let completionCalls = 0;
  const impl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const call = { url: String(input), body };
    calls.push(call);
    if (!call.url.endsWith('/completions')) return jsonRes({});
    const step = script[Math.min(completionCalls++, script.length - 1)];
    return step(call);
  };
  return { impl, calls };
}

const jsonRes = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

function assistantToolCall(calls: { id: string; name: string; args: unknown }[]) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  };
}

const validResult = {
  status: 'completed',
  summary: 'The 401 is emitted after refresh.',
  files: [{ path: 'src/a.ts', start_line: 1, end_line: 2, reason: 'refresh entry' }],
};

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'agent-ws-'));
  const { mkdir } = await import('fs/promises');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'function refresh() { return 401; }\n');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function run(impl: typeof fetch, overrides?: { manifest?: WorkerPluginManifest; now?: () => number }) {
  const config: WorkerRunConfig = {
    runId: 'asr_test',
    query: 'find the 401',
    modelProfile: 'search-fast',
    manifest: overrides?.manifest ?? manifest,
    promptMd: 'prompt',
    outputSchemaJson: '{}',
    workspaceRoot: workspace,
    baseUrl: 'http://gateway.test',
    serviceToken: 'tok',
    fetchImpl: impl,
    now: overrides?.now,
  };
  return runSearchAgent(config);
}

describe('runSearchAgent', () => {
  it('completes when the model submits a valid result', async () => {
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([{ id: 't1', name: 'grep_search', args: { pattern: '401' } }])),
      () => jsonRes(assistantToolCall([{ id: 't2', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl);

    const report = calls.find((c) => c.url.endsWith('/report'));
    expect(report?.body.kind).toBe('completed');
    expect(report?.body.result.summary).toContain('401');
    expect(report?.body.result.run_id).toBe('asr_test');
    expect(report?.body.usage.tool_calls).toBe(1);

    const toolEvents = calls.filter((c) => c.url.endsWith('/events'));
    expect(toolEvents.map((c) => c.body.type)).toContain('tool.started');
  });

  it('runs parallel discovery before reading a candidate window and submitting', async () => {
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([
        { id: 'g1', name: 'grep_search', args: { pattern: '401' } },
        { id: 'g2', name: 'glob_files', args: { pattern: 'src/*.ts' } },
      ])),
      () => jsonRes(assistantToolCall([{ id: 'r1', name: 'read_file', args: { path: 'src/a.ts', offset: 1, limit: 1 } }])),
      () => jsonRes(assistantToolCall([{ id: 's1', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl);

    const completions = calls.filter((call) => call.url.endsWith('/completions'));
    expect(completions).toHaveLength(3);
    expect(completions[1].body.messages.map((message: any) => message.tool_call_id)).toEqual(expect.arrayContaining(['g1', 'g2']));
    expect(completions[2].body.messages.find((message: any) => message.tool_call_id === 'r1').content).toContain('src/a.ts lines 1-1');
    expect(calls.find((call) => call.url.endsWith('/report'))?.body.kind).toBe('completed');
  });

  it('performs one repair round then accepts the corrected result', async () => {
    const invalid = { status: 'completed', files: [{ path: 'a.ts' }] };
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([{ id: 't1', name: 'submit_result', args: { result: invalid } }])),
      () => jsonRes(assistantToolCall([{ id: 't2', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl);
    const report = calls.find((c) => c.url.endsWith('/report'));
    expect(report?.body.kind).toBe('completed');
  });

  it('fails after one failed repair attempt', async () => {
    const invalid = { status: 'completed', files: [] };
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([{ id: 't1', name: 'submit_result', args: { result: invalid } }])),
      () => jsonRes(assistantToolCall([{ id: 't2', name: 'submit_result', args: { result: invalid } }])),
    ]);
    await run(impl);
    const report = calls.find((c) => c.url.endsWith('/report'));
    expect(report?.body.kind).toBe('failed');
    expect(report?.body.error_code).toBe('output_validation_failed');
  });

  it('reports policy denial for tools outside the allowlist', async () => {
    const { impl, calls } = fakeFetch([
      () =>
        jsonRes(
          assistantToolCall([
            { id: 't1', name: 'bash', args: { command: 'rm -rf /' } },
          ]),
        ),
      () => jsonRes(assistantToolCall([{ id: 't2', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl);

    const completion = calls.filter((c) => c.url.endsWith('/completions'))[1];
    const denialMessage = completion.body.messages.find(
      (m: any) => m.role === 'tool' && m.tool_call_id === 't1',
    );
    expect(denialMessage.content).toContain('not allowed by plugin tool policy');
  });

  it('hard-disables discovery tools in the convergence phase but still allows read_file', async () => {
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([{ id: 'g1', name: 'grep_search', args: { pattern: '401' } }])),
      () => jsonRes(assistantToolCall([{ id: 'g2', name: 'grep_search', args: { pattern: 'refresh' } }])),
      () => jsonRes(assistantToolCall([
        { id: 'g3', name: 'grep_search', args: { pattern: 'late wandering' } },
        { id: 'r1', name: 'read_file', args: { path: 'src/a.ts', offset: 1, limit: 1 } },
      ])),
      () => jsonRes(assistantToolCall([{ id: 's1', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl);

    const completions = calls.filter((call) => call.url.endsWith('/completions'));
    // manifest fixture has max_turns 4 -> convergeTurn 3; grep at turn 3 is denied, read_file is not
    const nudge = completions[2].body.messages.find(
      (m: any) => m.role === 'user' && m.content.includes('Convergence phase'),
    );
    expect(nudge).toBeDefined();
    const denied = completions[3].body.messages.find((m: any) => m.tool_call_id === 'g3');
    expect(denied.content).toContain('discovery tools are disabled from turn 3');
    const read = completions[3].body.messages.find((m: any) => m.tool_call_id === 'r1');
    expect(read.content).toContain('src/a.ts lines 1-1');
    // early grep was NOT denied
    const early = completions[2].body.messages.find((m: any) => m.tool_call_id === 'g2');
    expect(early.content).not.toContain('disabled');
    expect(calls.find((c) => c.url.endsWith('/report'))?.body.kind).toBe('completed');
  });

  it('executes tools serially in call order when they share a turn with submit_result', async () => {
    // Mixed turn: read_file must run (and its tool.completed event fire) before
    // the submit_result in the same message is validated and completes the run.
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([
        { id: 'r1', name: 'read_file', args: { path: 'src/a.ts', offset: 1, limit: 1 } },
        { id: 's1', name: 'submit_result', args: { result: validResult } },
      ])),
    ]);
    await run(impl);

    const reportIndex = calls.findIndex((c) => c.url.endsWith('/report'));
    const completedEventIndex = calls.findIndex(
      (c) => c.url.endsWith('/events') && c.body.type === 'tool.completed',
    );
    const report = calls[reportIndex];
    expect(report?.body.kind).toBe('completed');
    expect(report?.body.usage.tool_calls).toBe(1);
    expect(completedEventIndex).toBeGreaterThan(-1);
    expect(completedEventIndex).toBeLessThan(reportIndex);
  });

  it('caps parallel fan-out at max_parallel_calls and reports overflow as errors', async () => {
    const limited: WorkerPluginManifest = {
      ...manifest,
      tool_policy: { ...manifest.tool_policy, max_parallel_calls: 2 },
    };
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([
        { id: 'g1', name: 'grep_search', args: { pattern: '401' } },
        { id: 'g2', name: 'glob_files', args: { pattern: 'src/*.ts' } },
        { id: 'g3', name: 'grep_search', args: { pattern: 'refresh' } },
      ])),
      () => jsonRes(assistantToolCall([{ id: 's1', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl, { manifest: limited });

    const completion = calls.filter((call) => call.url.endsWith('/completions'))[1];
    const byId = (id: string) => completion.body.messages.find((m: any) => m.tool_call_id === id);
    expect(byId('g1')?.content).toContain('match(es)');
    expect(byId('g2')?.content).toContain('match(es)');
    expect(byId('g3')?.content).toBe('error: max_parallel_calls is 2');
    const report = calls.find((c) => c.url.endsWith('/report'));
    expect(report?.body.usage.tool_calls).toBe(3);
  });

  it('rejects mixed-turn tool execution once the deadline passes mid-run', async () => {
    let clock = 0;
    const invalid = { status: 'completed', files: [] };
    const { impl, calls } = fakeFetch([
      () => {
        // Deadline (30s timeout - 5s safety margin = 25s) passes after the model
        // answered but before the same-turn read_file is executed. The rejected
        // call must short-circuit before any tool event yet still count in stats.
        clock = 100_000;
        return jsonRes(assistantToolCall([
          { id: 'r1', name: 'read_file', args: { path: 'src/a.ts', offset: 1, limit: 1 } },
          { id: 's1', name: 'submit_result', args: { result: invalid } },
        ]));
      },
    ]);
    await run(impl, { now: () => clock });

    const report = calls.find((c) => c.url.endsWith('/report'));
    // The next turn-start deadline check fails the run before repair can happen.
    expect(report?.body.kind).toBe('failed');
    expect(report?.body.error_code).toBe('timeout');
    expect(report?.body.usage.tool_calls).toBe(1);
    expect(calls.filter((c) => c.url.endsWith('/events')).map((c) => c.body.type)).toEqual([]);
  });

  it('still disables discovery tools in the convergence phase on mixed turns', async () => {
    const invalid = { status: 'completed', files: [] };
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([{ id: 'g1', name: 'grep_search', args: { pattern: '401' } }])),
      () => jsonRes(assistantToolCall([{ id: 'g2', name: 'grep_search', args: { pattern: 'refresh' } }])),
      () => jsonRes(assistantToolCall([
        { id: 'g3', name: 'grep_search', args: { pattern: 'late wandering' } },
        { id: 's1', name: 'submit_result', args: { result: invalid } },
      ])),
      // The invalid submit forces a repair round so the turn-3 tool messages are
      // actually replayed to the model and the serial-path denial is observable.
      () => jsonRes(assistantToolCall([{ id: 's2', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl);

    const completions = calls.filter((call) => call.url.endsWith('/completions'));
    // manifest fixture has max_turns 4 -> convergeTurn 3; the turn-3 mixed batch
    // must deny grep_search through the serial path yet still process submit_result.
    const replay = completions[3].body.messages;
    expect(replay.find((m: any) => m.tool_call_id === 'g3')?.content).toContain(
      'discovery tools are disabled from turn 3',
    );
    expect(replay.find((m: any) => m.tool_call_id === 's1')?.content).toContain('rejected:');
    const report = calls.find((c) => c.url.endsWith('/report'));
    expect(report?.body.kind).toBe('completed');
    expect(report?.body.usage.tool_calls).toBe(3);
  });

  it('ends with budget_exceeded when turns run out', async () => {
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([{ id: 't', name: 'glob_files', args: { pattern: '*.ts' } }])),
    ]);
    await run(impl);
    const report = calls.find((c) => c.url.endsWith('/report'));
    expect(report?.body.kind).toBe('budget_exceeded');
  });

  it('injects a depth-2 repo structure map into the first user message', async () => {
    const { impl, calls } = fakeFetch([
      () => jsonRes(assistantToolCall([{ id: 't1', name: 'grep_search', args: { pattern: '401' } }])),
      () => jsonRes(assistantToolCall([{ id: 't2', name: 'submit_result', args: { result: validResult } }])),
    ]);
    await run(impl);

    const first = calls.filter((c) => c.url.endsWith('/completions'))[0];
    const user = first.body.messages.find(
      (m: any) => m.role === 'user' && !m.content.includes('Convergence phase'),
    );
    expect(user.content).toContain('<repo_structure>');
    expect(user.content).toContain('src/');
    expect(user.content).toContain('src/a.ts');
    expect(user.content).toContain('<search_string>\nfind the 401\n</search_string>');
  });
});
