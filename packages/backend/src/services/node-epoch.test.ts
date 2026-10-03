import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import Fastify from 'fastify';
import { appConfig } from '../config/index.js';
import { NODE_BOOT_EPOCH, NODE_DISPATCH_PATH, NODE_EPOCH_PATH, forwardToOwner, verifyNodeEnvelope } from './node-dispatch.js';

test('owner restart causes a service error, never client-auth failure or automatic business replay', async () => {
  const peer = Fastify();
  let epoch: string = NODE_BOOT_EPOCH;
  let handshakes = 0;
  let dispatches = 0;
  let executions = 0;
  const secret = "node-test-".repeat(4);
  peer.get(NODE_EPOCH_PATH, () => {
    const response = { nodeId: 'node-b', epoch };
    handshakes++;
    if (handshakes === 1) epoch = randomUUID();
    return response;
  });
  peer.post(NODE_DISPATCH_PATH, (request, reply) => {
    dispatches++;
    const config = { enabled: true, id: 'node-b', controlId: 'node-a', peers: { "node-a": 'http://127.0.0.1' }, secret };
    if (!verifyNodeEnvelope(config, request.headers, JSON.stringify(request.body), Date.now(), new Map(), epoch)) {
      return reply.header('x-gateway-node-auth-failed', '1').code(401).send({ error: { code: 'invalid_node_auth' } });
    }
    executions++;
    return reply.send({ executed: true });
  });
  await peer.listen({ port: 0, host: '127.0.0.1' });
  appConfig.node = { enabled: true, id: 'node-a', controlId: 'node-a', peers: { "node-b": peer.listeningOrigin }, secret };
  const ingress = Fastify();
  ingress.post('/v1/chat/completions', async (request, reply) => {
    await forwardToOwner(request, reply, 'openai', { id: 'vk' }, { provider: { owner_node: 'node-b' }, providerId: 'provider' });
  });
  try {
    const first = await ingress.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'model' } });
    expect(first.statusCode).toBe(503);
    expect(first.json().error.code).toBe('peer_node_auth_failed');
    expect(dispatches).toBe(1);
    expect(executions).toBe(0);
    const second = await ingress.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'model' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().executed).toBe(true);
    expect(handshakes).toBe(2);
    expect(dispatches).toBe(2);
    expect(executions).toBe(1);
  } finally {
    await ingress.close();
    await peer.close();
  }
});
