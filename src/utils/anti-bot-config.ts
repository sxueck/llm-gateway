import { systemConfigDb } from '../db/index.js';

export interface AntiBotConfig {
  enabled: boolean;
  blockBots: boolean;
  blockSuspicious: boolean;
  allowedUserAgents: string[];
  blockedUserAgents: string[];
  logOnly: boolean;
  logHeaders: boolean;
}

const DEFAULT_CONFIG: AntiBotConfig = {
  enabled: false,
  blockBots: true,
  blockSuspicious: false,
  allowedUserAgents: [],
  blockedUserAgents: [],
  logOnly: true,
  logHeaders: false,
};

export async function loadAntiBotConfig(): Promise<AntiBotConfig> {
  try {
    const enabledCfg = await systemConfigDb.get('anti_bot_enabled');
    const blockBotsCfg = await systemConfigDb.get('anti_bot_block_bots');
    const blockSuspiciousCfg = await systemConfigDb.get('anti_bot_block_suspicious');
    const allowedUaCfg = await systemConfigDb.get('anti_bot_allowed_user_agents');
    const blockedUaCfg = await systemConfigDb.get('anti_bot_blocked_user_agents');
    const logOnlyCfg = await systemConfigDb.get('anti_bot_log_only');
    const logHeadersCfg = await systemConfigDb.get('anti_bot_log_headers');

    return {
      enabled: enabledCfg ? enabledCfg.value === 'true' : DEFAULT_CONFIG.enabled,
      blockBots: blockBotsCfg ? blockBotsCfg.value === 'true' : DEFAULT_CONFIG.blockBots,
      blockSuspicious: blockSuspiciousCfg ? blockSuspiciousCfg.value === 'true' : DEFAULT_CONFIG.blockSuspicious,
      allowedUserAgents: allowedUaCfg ? allowedUaCfg.value.split(',').map(s => s.trim()).filter(s => s) : DEFAULT_CONFIG.allowedUserAgents,
      blockedUserAgents: blockedUaCfg ? blockedUaCfg.value.split(',').map(s => s.trim()).filter(s => s) : DEFAULT_CONFIG.blockedUserAgents,
      logOnly: logOnlyCfg ? logOnlyCfg.value === 'true' : DEFAULT_CONFIG.logOnly,
      logHeaders: logHeadersCfg ? logHeadersCfg.value === 'true' : DEFAULT_CONFIG.logHeaders,
    };
  } catch (error) {
    throw new Error(`加载反爬虫配置失败: ${error}`);
  }
}

export function validateUserAgentPattern(pattern: string): { valid: boolean; error?: string } {
  if (!pattern || pattern.trim().length === 0) {
    return { valid: false, error: 'User-Agent 模式不能为空' };
  }

  if (pattern.length > 500) {
    return { valid: false, error: 'User-Agent 模式长度不能超过 500 字符' };
  }

  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (e) {
    return { valid: true };
  }
}

export function validateUserAgentList(patterns: string[]): { valid: boolean; error?: string } {
  if (patterns.length > 100) {
    return { valid: false, error: 'User-Agent 列表不能超过 100 条' };
  }

  for (const pattern of patterns) {
    const validation = validateUserAgentPattern(pattern);
    if (!validation.valid) {
      return validation;
    }
  }

  return { valid: true };
}

