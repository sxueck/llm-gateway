import { beforeEach, describe, expect, test } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { appConfig } from '../config/index.js';
import type { NodeConfig } from '../config/node.js';
import {
  NODE_BOOT_EPOCH, NODE_EPOCH_PATH, NODE_DISPATCH_PATH, filterNodeHeaders, forwardToOwner, isAllowedDispatchPath, isNodeLedgerSaturated,
  isRemoteProvider, providerOwner, signNodeEnvelope, verifyNodeEnvelope,
} from './node-dispatch.js';

const secret = "node-test-".repeat(4);
const source: NodeConfig = { enabled: true, id: 'node-a', controlId: 'node-a', peers: { "node-b": 'http://127.0.0.1:1' }, secret };
const destination: NodeConfig = { ...source, id: 'node-b', peers: { "node-a": 'http://127.0.0.1:2' } };
const disabled: NodeConfig = { enabled: false, id: 'local', controlId: 'local', peers: {}, secret: '' };
const serialized = JSON.stringify({ example: 'payload' });
const now = 1_800_000_000_000;

beforeEach(() => { appConfig.node = { ...disabled }; });

describe('node authentication', () => {
  test('rejects captured requests after owner restart even with an empty nonce ledger', () => {
    const headers = signNodeEnvelope(source, 'node-b', serialized, now);
    expect(verifyNodeEnvelope(destination, headers, serialized, now, new Map(), 'different-owner-boot')).toBeNull();
  });

  test('nonce saturation fails closed without evicting live replay protection', () => {
    const seen = new Map(Array.from({ length: 20_000 }, (_, index) => [`nonce-${index}`, now + 60_000]));
    const headers = signNodeEnvelope(source, 'node-b', serialized, now);
    expect(verifyNodeEnvelope(destination, headers, serialized, now, seen)).toBeNull();
    expect(seen.size).toBe(20_000);
  });

  test('accepts a signed peer request exactly once', () => {
    const seen = new Map<string, number>();
    const headers = signNodeEnvelope(source, 'node-b', serialized, now);
    expect(verifyNodeEnvelope(destination, headers, serialized, now, seen)).toBe('node-a');
    expect(verifyNodeEnvelope(destination, headers, serialized, now, seen)).toBeNull();
  });

  test('rejects tampering, unknown peers, expired timestamps, wrong destination and disabled mode', () => {
    const headers = signNodeEnvelope(source, 'node-b', serialized, now);
    expect(verifyNodeEnvelope(destination, headers, '{}', now, new Map())).toBeNull();
    expect(verifyNodeEnvelope({ ...destination, peers: {} }, headers, serialized, now, new Map())).toBeNull();
    expect(verifyNodeEnvelope(destination, headers, serialized, now + 60_001, new Map())).toBeNull();
    expect(verifyNodeEnvelope(source, headers, serialized, now, new Map())).toBeNull();
    expect(verifyNodeEnvelope(disabled, headers, serialized, now, new Map())).toBeNull();
    expect(verifyNodeEnvelope(destination, { ...headers, 'x-gateway-node-signature': 'x' }, serialized, now, new Map())).toBeNull();
  });

  test('saturated ledger prunes expired entries before reporting capacity', () => {
    // Mirror the MAX_NONCES literal in node-dispatch.ts (same as the saturation test above).
    const saturated = new Map(Array.from({ length: 20_000 }, (_, i) => [`node-a:nonce-${i}`, now + 60_000]));
    expect(isNodeLedgerSaturated(now, saturated)).toBe(true);
    const allExpired = new Map(Array.from({ length: 20_000 }, (_, i) => [`node-a:nonce-${i}`, now - 1]));
    expect(isNodeLedgerSaturated(now, allExpired)).toBe(false);
    expect(isNodeLedgerSaturated(now, new Map([['node-a:live', now + 60_000]]))).toBe(false);
  });

  test('keeps future-dated nonces for the entire acceptance window', () => {
    const headers = signNodeEnvelope(source, 'node-b', serialized, now + 59_000);
    const seen = new Map<string, number>();
    expect(verifyNodeEnvelope(destination, headers, serialized, now, seen)).toBe('node-a');
    expect(verifyNodeEnvelope(destination, headers, serialized, now + 60_000, seen)).toBeNull();
  });
});

test('default ownership is control node and explicit ownership fails closed in single-node mode', () => {
  expect(providerOwner({}, source)).toBe('node-a');
  expect(isRemoteProvider({ owner_node: 'node-b' }, source)).toBe(true);
  expect(isRemoteProvider({}, disabled)).toBe(false);
  expect(isRemoteProvider({ owner_node: 'node-b' }, disabled)).toBe(true);
});

test('dispatch paths cannot address admin, internal routes or arbitrary origins', () => {
  expect(isAllowedDispatchPath('openai', 'http', '/v1/chat/completions')).toBe(true);
  expect(isAllowedDispatchPath('anthropic', 'http', '/v1/messages')).toBe(true);
  expect(isAllowedDispatchPath('gemini', 'http', '/v1beta/models/test:streamGenerateContent?alt=sse')).toBe(true);
  expect(isAllowedDispatchPath('openai', 'responses-ws', '/responses')).toBe(true);
  for (const path of ['/api/admin/providers', NODE_DISPATCH_PATH, '//evil.test/v1/responses', '/v1/responses#fragment', '/v1\\responses']) {
    expect(isAllowedDispatchPath('openai', 'http', path)).toBe(false);
  }
  expect(isAllowedDispatchPath('anthropic', 'responses-ws', '/v1/responses')).toBe(false);
});

test('does not forward credentials, internal privileges or hop-by-hop headers', () => {
  expect(filterNodeHeaders({
    authorization: 'Bearer private', 'x-api-key': 'private', 'x-agent-loopback-token': 'private',
    'x-gateway-node-source': 'forged', connection: 'x-custom-hop', 'x-custom-hop': 'secret',
    cookie: 'private', 'anthropic-beta': 'test-beta', 'user-agent': 'client', 'bad-header': 'a\r\nb',
  })).toEqual({ 'anthropic-beta': 'test-beta', 'user-agent': 'client' });
});

test('forwards a real streaming HTTP response without buffering the full body', async () => {
  const peer = Fastify();
  peer.get(NODE_EPOCH_PATH, () => ({ nodeId: 'node-b', epoch: NODE_BOOT_EPOCH }));
  let finishPeer: (() => void) | undefined;
  peer.post(NODE_DISPATCH_PATH, async (request, reply) => {
    expect(verifyNodeEnvelope({ ...destination, peers: { "node-a": 'http://127.0.0.1:2' } }, request.headers, JSON.stringify(request.body))).toBe('node-a');
    expect((request.body as any).resolution.providerId).toBe('foreign-provider');
    expect((request.body as any).headers.authorization).toBeUndefined();
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream-test': 'owner', 'x-max-completion-tokens': '100' });
    reply.raw.write('data: first\n\n');
    await new Promise<void>(resolve => { finishPeer = resolve; });
    reply.raw.end('data: [DONE]\n\n');
  });
  await peer.listen({ port: 0, host: '127.0.0.1' });
  const ingress = Fastify();
  appConfig.node = { ...source, peers: { "node-b": peer.listeningOrigin } };
  ingress.post('/v1/chat/completions', async (request, reply) => {
    reply.header('x-max-completion-tokens', '5');
    reply.raw.setHeader('x-gateway-provider', 'failed-target');
    await forwardToOwner(request, reply, 'openai', { id: 'vk' }, {
      provider: { owner_node: 'node-b' }, providerId: 'foreign-provider',
    });
  });
  await ingress.listen({ port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(`${ingress.listeningOrigin}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer private' },
      body: JSON.stringify({ model: 'test-model', stream: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-execution-node')).toBe('node-b');
    expect(response.headers.get('x-upstream-test')).toBe('owner');
    expect(response.headers.get('x-max-completion-tokens')).toBe('100');
    expect(response.headers.get('x-gateway-provider')).toBeNull();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: first');
    finishPeer!();
    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toContain('[DONE]');
  } finally {
    finishPeer?.();
    await ingress.close();
    await peer.close();
  }
});

test('an unavailable owner is not executed locally or retried', async () => {
  appConfig.node = { ...source, peers: {} };
  const app = Fastify();
  let dispatches = 0;
  app.post('/v1/chat/completions', async (request, reply) => {
    const forwarded = await forwardToOwner(request, reply, 'openai', { id: 'vk' }, {
      provider: { owner_node: 'node-b' }, providerId: 'foreign-provider',
    });
    if (!forwarded) dispatches++;
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'test' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('owner_node_unconfigured');
    expect(dispatches).toBe(0);
  } finally { await app.close(); }
});

test('forwarding cancellation closes the owner response', async () => {
  const peer = Fastify();
  peer.get(NODE_EPOCH_PATH, () => ({ nodeId: 'node-b', epoch: NODE_BOOT_EPOCH }));
  let markClosed: (() => void) | undefined;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  peer.post(NODE_DISPATCH_PATH, (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: first\n\n');
    reply.raw.once('close', markClosed!);
  });
  await peer.listen({ port: 0, host: '127.0.0.1' });
  appConfig.node = { ...source, peers: { "node-b": peer.listeningOrigin } };
  const ingress = Fastify();
  ingress.post('/v1/chat/completions', async (request: FastifyRequest, reply) => {
    await forwardToOwner(request, reply, 'openai', { id: 'vk' }, { provider: { owner_node: 'node-b' }, providerId: 'foreign-provider' });
  });
  await ingress.listen({ port: 0, host: '127.0.0.1' });
  try {
    const controller = new AbortController();
    const response = await fetch(`${ingress.listeningOrigin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('owner not cancelled')), 1500))]);
  } finally {
    await ingress.close();
    await peer.close();
  }
});
