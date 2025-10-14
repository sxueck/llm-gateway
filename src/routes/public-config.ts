import { FastifyInstance } from 'fastify';
import { systemConfigDb } from '../db/index.js';
import { demoModeService } from '../services/demo-mode.js';

export async function publicConfigRoutes(fastify: FastifyInstance) {
  fastify.get('/system-settings', async () => {
    const allowRegCfg = systemConfigDb.get('allow_registration');
    const corsEnabledCfg = systemConfigDb.get('cors_enabled');

    return {
      allowRegistration: !(allowRegCfg && allowRegCfg.value === 'false'),
      corsEnabled: corsEnabledCfg ? corsEnabledCfg.value === 'true' : true,
      demoMode: demoModeService.isEnabled(),
      nextCleanupTime: demoModeService.isEnabled() ? demoModeService.getNextCleanupTime() : null,
    };
  });
}

