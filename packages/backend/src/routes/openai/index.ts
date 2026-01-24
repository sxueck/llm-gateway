import { FastifyInstance } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { createOpenAIProxyHandler } from './proxy-handler.js';

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
  proxy: {
    routes: [
      { path: '/chat/completions', method: 'ALL', handler: 'proxy' },
      { path: '/responses', method: 'ALL', handler: 'proxy' },
      { path: '/completions', method: 'ALL', handler: 'proxy' },
      { path: '/embeddings', method: 'ALL', handler: 'proxy' },
      { path: '/audio/*', method: 'ALL', handler: 'proxy' },
      { path: '/images/*', method: 'ALL', handler: 'proxy' },
      { path: '/moderations', method: 'ALL', handler: 'proxy' },
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
      memoryLogger.error(`Handler not found: ${route.handler}`, 'OpenAI');
      return;
    }

    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch' | 'all';
    fastify[method](route.path, handler);

    if (group.withV1Prefix) {
      fastify[method](`/v1${route.path}`, handler);
    }

    memoryLogger.debug(`Registered OpenAI route: ${route.method} ${route.path}`, 'OpenAI');
  });
}

export async function openaiRoutes(fastify: FastifyInstance) {
  const handlers: Record<string, any> = {
    proxy: createOpenAIProxyHandler(),
  };

  registerApiGroup(fastify, API_GROUPS.proxy, handlers);
}
