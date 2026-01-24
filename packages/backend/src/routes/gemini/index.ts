import { FastifyInstance } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { createGeminiProxyHandler } from './proxy-handler.js';

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
  gemini: {
    routes: [
      { path: '/v1beta/models/*', method: 'ALL', handler: 'proxy' },
      { path: '/v1beta/*', method: 'ALL', handler: 'proxy' },
    ],
    withV1Prefix: false,
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
      memoryLogger.error(`Handler not found: ${route.handler}`, 'Gemini');
      return;
    }

    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch' | 'all';
    fastify[method](route.path, handler);

    if (group.withV1Prefix) {
      fastify[method](`/v1${route.path}`, handler);
    }

    memoryLogger.debug(`Registered Gemini route: ${route.method} ${route.path}`, 'Gemini');
  });
}

export async function geminiRoutes(fastify: FastifyInstance) {
  const handlers: Record<string, any> = {
    proxy: createGeminiProxyHandler(),
  };

  registerApiGroup(fastify, API_GROUPS.gemini, handlers);
}
