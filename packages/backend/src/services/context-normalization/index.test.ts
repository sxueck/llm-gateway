import { beforeEach, describe, expect, test, vi } from 'vitest';

// Stateful in-memory mock for the repository. Each test installs the desired
// binding state and records written events / updates.
const repoMock = vi.hoisted(() => {
  let activeBinding: any = null;
  let created: any[] = [];
  let events: any[] = [];
  let updated: any[] = [];
  let throwOnRead = false;
  let createOverride: any = null;

  return {
    async getActiveBinding() {
      if (throwOnRead) throw new Error('db down');
      return activeBinding;
    },
    async createBinding(_key: any, fingerprint: string, protocol: string) {
      const row = createOverride ?? { fingerprint, protocol, context_version: 1 };
      activeBinding = row;
      created.push(row);
      return row;
    },
    async updateBindingOnSwitch(_key: any, fingerprint: string, protocol: string) {
      const version = (activeBinding?.context_version ?? 1) + 1;
      const row = { fingerprint, protocol, context_version: version };
      activeBinding = row;
      updated.push(row);
      return row;
    },
    async insertSwitchEvent(event: any) {
      events.push(event);
    },
    // test controls
    setActive(b: any) {
      activeBinding = b;
    },
    getCreated() {
      return created;
    },
    getEvents() {
      return events;
    },
    getUpdated() {
      return updated;
    },
    setThrowOnRead(v: boolean) {
      throwOnRead = v;
    },
    setCreateOverride(row: any) {
      createOverride = row;
    },
    reset() {
      activeBinding = null;
      created = [];
      events = [];
      updated = [];
      throwOnRead = false;
      createOverride = null;
    },
  };
});

vi.mock('../../db/repositories/context-normalization.repository.js', () => ({
  contextNormalizationRepository: {
    getActiveBinding: repoMock.getActiveBinding,
    createBinding: repoMock.createBinding,
    updateBindingOnSwitch: repoMock.updateBindingOnSwitch,
    insertSwitchEvent: repoMock.insertSwitchEvent,
  },
  resolveContextBindingScope: (id: string | undefined) => id || '__anonymous__',
}));

import { applyContextNormalization, normalizeContextForSwitch } from './index.js';

function makeRequest(sessionId?: string) {
  return { headers: sessionId ? { 'x-session-id': sessionId } : {}, body: {} };
}

const VK = { id: 'vk-1', context_normalization_enabled: 1 };

describe('normalizeContextForSwitch', () => {
  beforeEach(() => {
    repoMock.reset();
  });

  test('no session_id → skipped_no_session, no DB access', async () => {
    const body = { messages: [{ role: 'assistant', reasoning_content: 'x', content: '' }] };
    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest(),
      body,
      providerId: 'p',
      model: 'm',
      virtualKey: VK,
    });

    expect(result.decision).toBe('skipped_no_session');
    // Body untouched
    expect((body.messages as any[])[0].reasoning_content).toBe('x');
    expect(repoMock.getCreated()).toHaveLength(0);
  });

  test('first request → first, records binding, no body change', async () => {
    repoMock.setActive(null);
    const body = { messages: [{ role: 'user', content: 'hi' }] };

    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-1'),
      body,
      providerId: 'p',
      model: 'gpt-4o',
      virtualKey: VK,
    });

    expect(result.decision).toBe('first');
    expect(repoMock.getCreated()).toHaveLength(1);
    expect(repoMock.getEvents()).toHaveLength(0);
  });

  test('same fingerprint → same, zero body change, no event (AC-1)', async () => {
    // Compute the fingerprint that the service will compute for the same inputs.
    // We simulate a prior binding with the same fingerprint by running a first
    // request, then a second identical one.
    repoMock.setActive(null);
    const mkBody = () => ({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' });

    await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-2'),
      body: mkBody(),
      providerId: 'p',
      model: 'gpt-4o',
      virtualKey: VK,
    });

    // Second identical request: binding now exists with matching fingerprint.
    const body2 = mkBody();
    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-2'),
      body: body2,
      providerId: 'p',
      model: 'gpt-4o',
      virtualKey: VK,
    });

    expect(result.decision).toBe('same');
    expect(body2.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(repoMock.getEvents()).toHaveLength(0);
  });

  test('model switch → cleaned, reasoning stripped, event strategy=cleaned (AC-2)', async () => {
    // Seed a binding from model A.
    repoMock.setActive(null);
    await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-3'),
      body: { messages: [{ role: 'user', content: 'hi' }] },
      providerId: 'p',
      model: 'model-a',
      virtualKey: VK,
    });

    // Now switch to model B with reasoning history present.
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'answer', reasoning_content: 'secret', thinking_blocks: [{ text: 't' }] },
      ],
    };
    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-3'),
      body,
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(result.decision).toBe('cleaned');
    expect(result.cleanedBlocks).toBeGreaterThan(0);
    expect((body.messages as any[])[1].reasoning_content).toBeUndefined();
    expect((body.messages as any[])[1].thinking_blocks).toBeUndefined();
    expect((body.messages as any[])[1].content).toBe('answer');

    const events = repoMock.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].strategy).toBe('cleaned');
    expect(events[0].targetFingerprint).not.toBe(events[0].sourceFingerprint);
    expect(repoMock.getUpdated()).toHaveLength(1);
  });

  test('same model, reasoning_effort change → cleaned (AC-3)', async () => {
    repoMock.setActive(null);
    await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-4'),
      body: { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
      providerId: 'p',
      model: 'gpt-4o',
      virtualKey: VK,
    });

    const body = { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' };
    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-4'),
      body,
      providerId: 'p',
      model: 'gpt-4o',
      virtualKey: VK,
    });

    expect(result.decision).toBe('cleaned');
  });

  test('unfinished tool loop + switch → blocked_tool_loop, binding not updated (AC-5)', async () => {
    repoMock.setActive(null);
    await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-5'),
      body: { messages: [{ role: 'user', content: 'go' }] },
      providerId: 'p',
      model: 'model-a',
      virtualKey: VK,
    });

    const body = {
      messages: [
        { role: 'user', content: 'search' },
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search' } }], reasoning_content: 't' },
      ],
    };
    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-5'),
      body,
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(result.decision).toBe('blocked_tool_loop');
    expect(result.blockReason).toBeTruthy();
    // Binding must NOT be updated on block (R-804).
    expect(repoMock.getUpdated()).toHaveLength(0);
    const events = repoMock.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].strategy).toBe('blocked_tool_loop');
  });

  test('invalid sequence after cleaning (anthropic) → blocked_invalid_sequence (AC-6)', async () => {
    repoMock.setActive(null);
    await normalizeContextForSwitch({
      protocol: 'anthropic',
      request: makeRequest('sess-6'),
      body: { messages: [{ role: 'user', content: 'hi' }] },
      providerId: 'p',
      model: 'model-a',
      virtualKey: VK,
    });

    // Two consecutive thinking-only assistant messages between user messages:
    // cleaning removes both, collapsing user/user adjacency.
    const body = {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't1', signature: 's1' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't2', signature: 's2' }] },
        { role: 'user', content: 'b' },
      ],
    };
    const result = await normalizeContextForSwitch({
      protocol: 'anthropic',
      request: makeRequest('sess-6'),
      body,
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(result.decision).toBe('blocked_invalid_sequence');
    expect(repoMock.getUpdated()).toHaveLength(0);
    const events = repoMock.getEvents();
    expect(events[0].strategy).toBe('blocked_invalid_sequence');
  });

  test('DB read error → skipped_db_error, fail-open passthrough (Edge Cases)', async () => {
    repoMock.setThrowOnRead(true);
    const body = { messages: [{ role: 'assistant', reasoning_content: 'x', content: '' }] };

    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-7'),
      body,
      providerId: 'p',
      model: 'm',
      virtualKey: VK,
    });

    expect(result.decision).toBe('skipped_db_error');
    // Body untouched (fail-open).
    expect((body.messages as any[])[0].reasoning_content).toBe('x');
  });

  test('protocol change detected via fingerprint (openai→anthropic, AC-4)', async () => {
    repoMock.setActive(null);
    await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-8'),
      body: { messages: [{ role: 'user', content: 'hi' }] },
      providerId: 'p',
      model: 'shared-model',
      virtualKey: VK,
    });

    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const result = await normalizeContextForSwitch({
      protocol: 'anthropic',
      request: makeRequest('sess-8'),
      body,
      providerId: 'p',
      model: 'shared-model',
      virtualKey: VK,
    });

    expect(result.decision).toBe('cleaned');
  });

  test('switch disabled → skipped_disabled, no DB access (AC-7)', async () => {
    const body = { messages: [{ role: 'assistant', reasoning_content: 'x', content: '' }] };
    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-off'),
      body,
      providerId: 'p',
      model: 'm',
      virtualKey: { id: 'vk-1', context_normalization_enabled: 0 },
    });

    expect(result.decision).toBe('skipped_disabled');
    expect((body.messages as any[])[0].reasoning_content).toBe('x');
    expect(repoMock.getCreated()).toHaveLength(0);
  });

  test('lost first-request race with a different fingerprint → cleaned', async () => {
    repoMock.setActive(null);
    repoMock.setCreateOverride({ fingerprint: 'other-fp', protocol: 'openai', context_version: 1 });

    const body = {
      messages: [{ role: 'assistant', content: 'answer', reasoning_content: 'secret' }],
    };
    const result = await normalizeContextForSwitch({
      protocol: 'openai',
      request: makeRequest('sess-race'),
      body,
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(result.decision).toBe('cleaned');
    expect((body.messages as any[])[0].reasoning_content).toBeUndefined();
    expect(repoMock.getUpdated()).toHaveLength(1);
  });

  test('blocked_invalid_sequence leaves the original body untouched', async () => {
    repoMock.setActive(null);
    await normalizeContextForSwitch({
      protocol: 'anthropic',
      request: makeRequest('sess-preserve'),
      body: { messages: [{ role: 'user', content: 'hi' }] },
      providerId: 'p',
      model: 'model-a',
      virtualKey: VK,
    });

    const thinkingOnly = { role: 'assistant', content: [{ type: 'thinking', thinking: 't1', signature: 's1' }] };
    const body = {
      messages: [
        { role: 'user', content: 'a' },
        thinkingOnly,
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't2', signature: 's2' }] },
        { role: 'user', content: 'b' },
      ],
    };
    const result = await normalizeContextForSwitch({
      protocol: 'anthropic',
      request: makeRequest('sess-preserve'),
      body,
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(result.decision).toBe('blocked_invalid_sequence');
    expect(body.messages[1]).toBe(thinkingOnly);
    expect((body.messages[1] as any).content[0].type).toBe('thinking');
    expect(repoMock.getUpdated()).toHaveLength(0);
  });
});

describe('applyContextNormalization', () => {
  beforeEach(() => {
    repoMock.reset();
  });

  test('flag off → not blocked and never reads binding', async () => {
    const applied = await applyContextNormalization({
      protocol: 'openai',
      request: makeRequest('sess-flag'),
      body: { messages: [{ role: 'user', content: 'hi' }] },
      providerId: 'p',
      model: 'm',
      virtualKey: { id: 'vk-1', context_normalization_enabled: 0 },
    });

    expect(applied).toEqual({ blocked: false });
    expect(repoMock.getCreated()).toHaveLength(0);
  });

  test('blocked tool loop → OpenAI 400 shape with context_switch_blocked', async () => {
    repoMock.setActive({ fingerprint: 'old', protocol: 'openai', context_version: 1 });
    const applied = await applyContextNormalization({
      protocol: 'openai',
      request: makeRequest('sess-block'),
      body: {
        messages: [
          { role: 'user', content: 'search' },
          { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search' } }] },
        ],
      },
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(applied.blocked).toBe(true);
    if (!applied.blocked) return;
    expect(applied.status).toBe(400);
    expect(applied.body).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'context_switch_blocked',
      },
    });
  });

  test('blocked invalid sequence → Anthropic error envelope', async () => {
    repoMock.setActive({ fingerprint: 'old', protocol: 'anthropic', context_version: 1 });
    const applied = await applyContextNormalization({
      protocol: 'anthropic',
      request: makeRequest('sess-anth'),
      body: {
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 't1', signature: 's1' }] },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 't2', signature: 's2' }] },
          { role: 'user', content: 'b' },
        ],
      },
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(applied.blocked).toBe(true);
    if (!applied.blocked) return;
    expect(applied.body).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
  });

  test('blocked tool loop → Gemini INVALID_ARGUMENT shape', async () => {
    repoMock.setActive({ fingerprint: 'old', protocol: 'gemini', context_version: 1 });
    const applied = await applyContextNormalization({
      protocol: 'gemini',
      request: makeRequest('sess-gem'),
      body: {
        contents: [
          { role: 'user', parts: [{ text: 'x' }] },
          { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
        ],
      },
      providerId: 'p',
      model: 'model-b',
      virtualKey: VK,
    });

    expect(applied.blocked).toBe(true);
    if (!applied.blocked) return;
    expect(applied.body).toMatchObject({
      error: { code: 400, status: 'INVALID_ARGUMENT' },
    });
  });
});
