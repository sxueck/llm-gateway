import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  isControlNode,
  isGuardedNodePath,
  registerNodeControlGuard,
} from './node-control.js';
import type { NodeConfig } from '../config/node.js';

const SECRET = "0".repeat(32);

function disabledConfig(): NodeConfig {
  return {
    enabled: false,
    id: 'local',
    controlId: 'local',
    peers: {},
    secret: '',
  };
}

function controlConfig(): NodeConfig {
  return {
    enabled: true,
    id: 'node-a',
    controlId: 'node-a',
    peers: { 'node-b': 'https://node-b.example.com' },
    secret: SECRET,
  };
}

function nonControlConfig(): NodeConfig {
  return {
    enabled: true,
    id: 'node-b',
    controlId: 'node-a',
    peers: { 'node-a': 'https://node-a.example.com' },
    secret: SECRET,
  };
}

describe('isControlNode', () => {
  it('treats disabled config as control (single-node compatibility)', () => {
    expect(isControlNode(disabledConfig())).toBe(true);
  });

  it('returns true when id equals controlId', () => {
    expect(isControlNode(controlConfig())).toBe(true);
  });

  it('returns false for a non-control node', () => {
    expect(isControlNode(nonControlConfig())).toBe(false);
  });
});

describe('isGuardedNodePath', () => {
  it('guards admin, agent and internal agent paths', () => {
    for (const path of [
      '/api/admin',
      '/api/auth/login',
      '/api/admin/',
      '/api/admin/providers',
      '/api/admin/config/debug-stream',
      '/api/agent',
      '/api/agent/snapshots',
      '/api/agent/searches/123',
      '/api/internal/agent',
      '/api/internal/agent/runs/abc',
    ]) {
      expect(isGuardedNodePath(path), path).toBe(true);
    }
  });

  it('ignores query strings when matching', () => {
    expect(isGuardedNodePath('/api/admin/providers?limit=10')).toBe(true);
  });

  it('does not guard other paths', () => {
    for (const path of [
      '/api/public/config',
      '/v1/chat/completions',
      '/health',
      '/api/administrative-not-a-real-route',
      '/api/agents-doc',
      '/',
    ]) {
      expect(isGuardedNodePath(path), path).toBe(false);
    }
  });
});

describe('registerNodeControlGuard', () => {
  async function buildApp(config: NodeConfig, registerDebugStream = true) {
    const app = Fastify();
    // 守卫必须在任何路由之前注册（与 src/index.ts 中的顺序一致）
    registerNodeControlGuard(app, config);
    if (registerDebugStream) {
      // 模拟在守卫之后注册的 debug-stream：仍需被拦截
      app.get('/api/admin/config/debug-stream', async () => ({ ok: true }));
    }
    app.get('/api/auth/login', async () => ({ ok: true }));
    app.get('/api/public/config', async () => ({ ok: true }));
    app.post('/v1/chat/completions', async () => ({ ok: true }));
    app.get('/api/admin/providers', async () => ({ ok: true }));
    app.post('/api/agent/snapshots', async () => ({ ok: true }));
    app.delete('/api/internal/agent/runs/:id', async () => ({ ok: true }));
    app.put('/api/admin/config/x', async () => ({ ok: true }));
    app.patch('/api/admin/config/x', async () => ({ ok: true }));
    app.head('/api/admin/config/x', async () => ({ ok: true, method: 'HEAD' }));
    return app;
  }

  it('denies all methods on guarded paths with 503 control_node_required', async () => {
    const app = await buildApp(nonControlConfig());
    const cases: Array<{
      method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH' | 'HEAD' | 'OPTIONS';
      url: string;
    }> = [
      { method: 'GET', url: '/api/admin/providers' },
      { method: 'GET', url: '/api/auth/login' },
      { method: 'GET', url: '/api/admin/config/debug-stream' },
      { method: 'POST', url: '/api/agent/snapshots' },
      { method: 'DELETE', url: '/api/internal/agent/runs/abc' },
      { method: 'PUT', url: '/api/admin/config/x' },
      { method: 'PATCH', url: '/api/admin/config/x' },
      { method: 'HEAD', url: '/api/admin/config/x' },
      { method: 'OPTIONS', url: '/api/admin/config/x' },
    ];
    for (const { method, url } of cases) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      if (method !== 'HEAD') {
        expect(res.json()).toEqual({
          error: {
            message: expect.any(String),
            type: 'invalid_request_error',
            param: null,
            code: 'control_node_required',
          },
        });
      }
      expect(res.headers.location, `${method} ${url}`).toBeUndefined();
    }
  });

  it('allows non-admin paths on a non-control node', async () => {
    const app = await buildApp(nonControlConfig());
    const auth = await app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(auth.statusCode).toBe(503);
    const pub = await app.inject({ method: 'GET', url: '/api/public/config' });
    expect(pub.statusCode).toBe(200);
    const proxy = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
    });
    expect(proxy.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/health' });
    expect(missing.statusCode).toBe(404);
  });

  it('does not affect a control node', async () => {
    const app = await buildApp(controlConfig());
    const admin = await app.inject({
      method: 'GET',
      url: '/api/admin/providers',
    });
    expect(admin.statusCode).toBe(200);
    const debug = await app.inject({
      method: 'GET',
      url: '/api/admin/config/debug-stream',
    });
    expect(debug.statusCode).toBe(200);
  });

  it('does not affect disabled (single-node) config', async () => {
    const app = await buildApp(disabledConfig());
    const admin = await app.inject({
      method: 'GET',
      url: '/api/admin/providers',
    });
    expect(admin.statusCode).toBe(200);
    const agent = await app.inject({
      method: 'POST',
      url: '/api/agent/snapshots',
    });
    expect(agent.statusCode).toBe(200);
  });
});
