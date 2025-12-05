import { FastifyInstance } from 'fastify';
import { systemConfigDb } from '../db/index.js';
import { demoModeService } from '../services/demo-mode.js';
import { memoryLogger } from '../services/logger.js';

export async function publicConfigRoutes(fastify: FastifyInstance) {
  fastify.get('/system-settings', async (_request, reply) => {
    try {
      const allowRegCfg = await systemConfigDb.get('allow_registration');
      const corsEnabledCfg = await systemConfigDb.get('cors_enabled');

      return {
        allowRegistration: !(allowRegCfg && allowRegCfg.value === 'false'),
        corsEnabled: corsEnabledCfg ? corsEnabledCfg.value === 'true' : true,
        demoMode: demoModeService.isEnabled(),
        nextCleanupTime: demoModeService.isEnabled() ? demoModeService.getNextCleanupTime() : null,
      };
    } catch (error: any) {
      memoryLogger.error(`获取系统配置失败: ${error.message}`, 'System');
      return reply.code(500).send({
        error: {
          message: `获取系统配置失败: ${error.message}`,
          type: 'internal_error',
          code: 'system_config_error'
        }
      });
    }
  });
}

