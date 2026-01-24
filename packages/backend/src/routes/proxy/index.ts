import { FastifyInstance } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { getModelsHandler, getModelInfoHandler } from './model-handlers.js';
import { startCacheStatsLogger } from './cache.js';

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
  models: {
    routes: [
      { path: '/models', method: 'GET', handler: 'getModels' },
      { path: '/model/info', method: 'GET', handler: 'getModelInfo' },
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
      memoryLogger.error(`Handler not found: ${route.handler}`, 'Proxy');
      return;
    }

    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch' | 'all';
    fastify[method](route.path, handler);

    if (group.withV1Prefix) {
      fastify[method](`/v1${route.path}`, handler);
    }

    memoryLogger.debug(`Registered route: ${route.method} ${route.path}`, 'Proxy');
  });
}

export async function proxyRoutes(fastify: FastifyInstance) {
  const handlers: Record<string, any> = {
    getModels: getModelsHandler,
    getModelInfo: getModelInfoHandler,
  };

  registerApiGroup(fastify, API_GROUPS.models, handlers);

  startCacheStatsLogger();
}
