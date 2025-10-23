import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import https from 'https';
import http from 'http';
import { portkeyGatewayDb, modelRoutingRuleDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';
import { portkeyRouter } from '../services/portkey-router.js';
import { appConfig } from '../config/index.js';
import type { PortkeyGateway } from '../types/index.js';
import { NotFoundError } from '../utils/error-handler.js';
import { AGENT_DEFAULTS } from '../constants/agent.js';

async function generateInstallScripts(gateway: PortkeyGateway) {
  const { generateInstallScript, generateInstallCommand } = await import('../services/agent-installer.js');

  const config = {
    gatewayId: gateway.id,
    gatewayName: gateway.name,
    apiKey: gateway.api_key!,
    agentPort: gateway.port || AGENT_DEFAULTS.AGENT_PORT,
    portkeyPort: AGENT_DEFAULTS.PORTKEY_PORT,
    llmGatewayUrl: appConfig.publicUrl,
  };

  return {
    installScript: generateInstallScript(config),
    installCommand: generateInstallCommand(config),
  };
}

interface HealthCheckResult {
  success: boolean;
  latency: number | null;
  error?: string;
  lastHeartbeat?: number;
  agentVersion?: string;
}

function buildHealthCheckResult(
  gateway: PortkeyGateway,
  success: boolean,
  latency: number | null,
  error?: string
): HealthCheckResult {
  return {
    success,
    latency,
    error,
    lastHeartbeat: gateway.last_heartbeat || undefined,
    agentVersion: gateway.agent_version || undefined,
  };
}

async function checkGatewayHealth(gateway: PortkeyGateway): Promise<HealthCheckResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    try {
      const url = new URL(`${gateway.url}/health`);
      const isHttps = url.protocol === 'https:';
      const requestModule = isHttps ? https : http;

      const headers: Record<string, string> = {};
      if (gateway.api_key) {
        headers['X-Gateway-ID'] = gateway.id;
        headers['X-API-Key'] = gateway.api_key;
      }

      const options: any = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        timeout: 5000,
      };

      if (isHttps) {
        options.rejectUnauthorized = false;
      }

      const req = requestModule.request(options, (res) => {
        res.resume();

        const latency = Date.now() - startTime;
        if (res.statusCode === 200 || res.statusCode === 404) {
          resolve(buildHealthCheckResult(gateway, true, latency));
        } else {
          resolve(buildHealthCheckResult(gateway, false, null, `HTTP ${res.statusCode}`));
        }
      });

      req.on('error', (error: any) => {
        resolve(buildHealthCheckResult(gateway, false, null, error.message));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(buildHealthCheckResult(gateway, false, null, 'Request timeout'));
      });

      req.end();
    } catch (error: any) {
      resolve(buildHealthCheckResult(gateway, false, null, error.message));
    }
  });
}

export async function portkeyGatewayRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async () => {
    try {
      const gateways = portkeyGatewayDb.getAll();
      return gateways.map(gateway => ({
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        description: gateway.description,
        isDefault: gateway.is_default === 1,
        enabled: gateway.enabled === 1,
        containerName: gateway.container_name,
        port: gateway.port,
        apiKey: gateway.api_key,
        installStatus: gateway.install_status,
        lastHeartbeat: gateway.last_heartbeat,
        agentVersion: gateway.agent_version,
        createdAt: gateway.created_at,
        updatedAt: gateway.updated_at,
      }));
    } catch (error: any) {
      memoryLogger.error(`获取 Portkey Gateway 列表失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.get('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const gateway = portkeyGatewayDb.getById(id);

      if (!gateway) {
        throw new NotFoundError('Portkey Gateway 不存在');
      }

      return {
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        description: gateway.description,
        isDefault: gateway.is_default === 1,
        enabled: gateway.enabled === 1,
        containerName: gateway.container_name,
        port: gateway.port,
        apiKey: gateway.api_key,
        installStatus: gateway.install_status,
        lastHeartbeat: gateway.last_heartbeat,
        agentVersion: gateway.agent_version,
        createdAt: gateway.created_at,
        updatedAt: gateway.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`获取 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.get('/:id/health', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const gateway = portkeyGatewayDb.getById(id);

      if (!gateway) {
        return { success: false, latency: null, error: 'Gateway 不存在' };
      }

      return await checkGatewayHealth(gateway);
    } catch (error: any) {
      memoryLogger.error(`检测 Gateway 健康状态失败: ${error.message}`, 'PortkeyGateways');
      return { success: false, latency: null, error: error.message };
    }
  });

  fastify.post('/', async (request) => {
    try {
      const body = request.body as {
        name: string;
        url: string;
        description?: string;
        isDefault?: boolean;
        enabled?: boolean;
        containerName?: string;
        port?: number;
      };

      const id = nanoid();
      const gateway = await portkeyGatewayDb.create({
        id,
        name: body.name,
        url: body.url,
        description: body.description,
        is_default: body.isDefault ? 1 : 0,
        enabled: body.enabled !== false ? 1 : 0,
        container_name: body.containerName,
        port: body.port,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(`创建 Portkey Gateway: ${body.name} (${body.url})`, 'PortkeyGateways');

      return {
        id: gateway!.id,
        name: gateway!.name,
        url: gateway!.url,
        description: gateway!.description,
        isDefault: gateway!.is_default === 1,
        enabled: gateway!.enabled === 1,
        containerName: gateway!.container_name,
        port: gateway!.port,
        apiKey: gateway!.api_key,
        installStatus: gateway!.install_status,
        createdAt: gateway!.created_at,
        updatedAt: gateway!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`创建 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.put('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        url?: string;
        description?: string;
        isDefault?: boolean;
        enabled?: boolean;
        containerName?: string;
        port?: number;
      };

      const gateway = await portkeyGatewayDb.update(id, {
        name: body.name,
        url: body.url,
        description: body.description,
        is_default: body.isDefault !== undefined ? (body.isDefault ? 1 : 0) : undefined,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
        container_name: body.containerName,
        port: body.port,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(`更新 Portkey Gateway: ${id}`, 'PortkeyGateways');

      return {
        id: gateway!.id,
        name: gateway!.name,
        url: gateway!.url,
        description: gateway!.description,
        isDefault: gateway!.is_default === 1,
        enabled: gateway!.enabled === 1,
        containerName: gateway!.container_name,
        port: gateway!.port,
        apiKey: gateway!.api_key,
        installStatus: gateway!.install_status,
        createdAt: gateway!.created_at,
        updatedAt: gateway!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`更新 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.delete('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      await portkeyGatewayDb.delete(id);
      
      portkeyRouter.clearCache();

      memoryLogger.info(`删除 Portkey Gateway: ${id}`, 'PortkeyGateways');
      
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.post('/generate-install-script', async (request) => {
    try {
      const body = request.body as {
        name: string;
        url: string;
        port?: number;
        description?: string;
        isDefault?: boolean;
      };

      const agentPort = body.port || AGENT_DEFAULTS.AGENT_PORT;
      const id = nanoid();
      const apiKey = `pgw_${nanoid(32)}`;

      const gateway = await portkeyGatewayDb.create({
        id,
        name: body.name,
        url: body.url,
        description: body.description,
        is_default: body.isDefault ? 1 : 0,
        enabled: 0,
        api_key: apiKey,
        install_status: 'pending',
        port: agentPort,
      });

      portkeyRouter.clearCache();

      const { installScript, installCommand } = await generateInstallScripts(gateway!);

      memoryLogger.info(
        `生成 Agent 安装脚本: ${body.name} (ID: ${id}, Agent 端口: ${agentPort})`,
        'PortkeyGateways'
      );

      return {
        success: true,
        message: '安装脚本生成成功',
        gateway: {
          id: gateway!.id,
          name: gateway!.name,
          url: gateway!.url,
          description: gateway!.description,
          isDefault: gateway!.is_default === 1,
          enabled: gateway!.enabled === 1,
          apiKey: gateway!.api_key,
          installStatus: gateway!.install_status,
          port: gateway!.port,
          createdAt: gateway!.created_at,
          updatedAt: gateway!.updated_at,
        },
        installScript,
        installCommand,
      };
    } catch (error: any) {
      memoryLogger.error(`生成安装脚本失败: ${error.message}`, 'PortkeyGateways');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.get('/:id/routing-rules', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const rules = modelRoutingRuleDb.getByGatewayId(id);

      return rules.map(rule => ({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        portkeyGatewayId: rule.portkey_gateway_id,
        ruleType: rule.rule_type,
        ruleValue: rule.rule_value,
        priority: rule.priority,
        enabled: rule.enabled === 1,
        createdAt: rule.created_at,
        updatedAt: rule.updated_at,
      }));
    } catch (error: any) {
      memoryLogger.error(`获取路由规则失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.get('/:id/install-script', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const gateway = portkeyGatewayDb.getById(id);

      if (!gateway) {
        throw new NotFoundError('Portkey Gateway 不存在');
      }

      if (!gateway.api_key) {
        throw new NotFoundError('该网关没有 API Key，无法生成安装脚本');
      }

      const { installScript, installCommand } = await generateInstallScripts(gateway);

      memoryLogger.info(
        `获取 Agent 安装脚本: ${gateway.name} (ID: ${id})`,
        'PortkeyGateways'
      );

      return {
        success: true,
        installScript,
        installCommand,
      };
    } catch (error: any) {
      memoryLogger.error(`获取安装脚本失败: ${error.message}`, 'PortkeyGateways');
      return {
        success: false,
        message: error.message,
      };
    }
  });
}

