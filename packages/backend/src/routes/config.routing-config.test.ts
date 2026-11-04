import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.JWT_SECRET ??= 'routing-config-test-secret-at-least-32-characters';
  process.env.MYSQL_PASSWORD ??= 'routing-config-test-password';
});

vi.mock('../services/threat-ip-blocker.js', () => ({ threatIpBlocker: {} }));

import { modelDb, routingConfigDb } from '../db/index.js';
import { configRoutes } from './config.js';

const validConfig = {
  strategy: {
    mode: 'time_priority',
    timezone: 'UTC',
    time_rules: [{ days: [1], start: '09:00', end: '18:00', target_order: [1, 0] }],
  },
  targets: [{ provider: 'a' }, { provider: 'b' }],
};

const storedConfig = {
  id: 'route-1',
  name: 'route',
  type: 'time_priority',
  config: JSON.stringify(validConfig),
  enabled: 1,
};

afterEach(() => vi.restoreAllMocks());

describe('PUT /routing-configs/:id', () => {
  it('rejects a replacement config that conflicts with the retained type', async () => {
    vi.spyOn(routingConfigDb, 'getById').mockResolvedValue(storedConfig);
    const update = vi.spyOn(routingConfigDb, 'update').mockResolvedValue(undefined);
    const app = Fastify();
    app.decorate('authenticate', async () => {});
    await app.register(configRoutes);
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/routing-configs/route-1',
        payload: {
          config: {
            strategy: { mode: 'loadbalance' },
            targets: [{ provider: 'a', weight: 0.5 }, { provider: 'b', weight: 0.5 }],
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: 'invalid_routing_config' });
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('accepts metadata-only updates to a valid stored time-priority config', async () => {
    vi.spyOn(routingConfigDb, 'getById').mockResolvedValue(storedConfig);
    const update = vi.spyOn(routingConfigDb, 'update').mockResolvedValue(undefined);
    vi.spyOn(modelDb, 'getAll').mockResolvedValue([]);
    const app = Fastify();
    app.decorate('authenticate', async () => {});
    await app.register(configRoutes);
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/routing-configs/route-1',
        payload: { name: 'renamed' },
      });
      expect(response.statusCode).toBe(200);
      expect(update).toHaveBeenCalledWith('route-1', expect.objectContaining({ name: 'renamed' }));
    } finally {
      await app.close();
    }
  });
});
