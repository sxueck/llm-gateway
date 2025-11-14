import { FastifyInstance } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { createAnthropicProxyHandler } from './proxy-handler.js';

interface RouteConfig {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ALL';
  handler: string;
}

interface ApiGroup {
  routes: RouteConfig[];
  withV1Prefix?: boolean;
}

const API_GROUPS: Record<string, ApiGroup> = {
  messages: {
    routes: [
      { path: '/messages', method: 'POST', handler: 'anthropicProxy' },
    ],
    withV1Prefix: true,
  },
};

function registerApiGroup(
  fastify: FastifyInstance,
  group: ApiGroup,
  handlers: Record<string, any>
) {
  group.routes.forEach(route => {
    const handler = handlers[route.handler];
    if (!handler) {
      memoryLogger.error(`Handler not found: ${route.handler}`, 'Anthropic');
      return;
    }

    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch' | 'all';
    fastify[method](route.path, handler);

    if (group.withV1Prefix) {
      fastify[method](`/v1${route.path}`, handler);
    }

    memoryLogger.debug(`Registered Anthropic route: ${route.method} ${route.path}`, 'Anthropic');
  });
}

export async function anthropicRoutes(fastify: FastifyInstance) {
  const handlers: Record<string, any> = {
    anthropicProxy: createAnthropicProxyHandler(),
  };

  registerApiGroup(fastify, API_GROUPS.messages, handlers);
}

