import { nanoid } from 'nanoid';
import { appConfig } from '../config/index.js';
import { getPool, userDb, flushApiRequestBufferNow } from '../db/index.js';
import { hashPassword } from '../utils/crypto.js';
import { memoryLogger } from './logger.js';
import { writeFile } from 'fs/promises';

const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo1234';
const CLEANUP_INTERVAL_DAYS = 3;

export class DemoModeService {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private nextCleanupTime: number = 0;

  async start(): Promise<void> {
    if (!appConfig.demoMode) {
      memoryLogger.info('演示模式未启用', 'DemoMode');
      return;
    }

    memoryLogger.info('演示模式已启用，将每 3 天自动清理数据', 'DemoMode');

    await this.performInitialSetup();

    this.scheduleNextCleanup();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
      memoryLogger.info('演示模式定时任务已停止', 'DemoMode');
    }
  }

  private async performInitialSetup(): Promise<void> {
    const existingUser = await userDb.findByUsername(DEMO_USERNAME);
    if (!existingUser) {
      await this.createDemoUser();
      memoryLogger.info('已创建演示用户', 'DemoMode');
    }
  }

  private scheduleNextCleanup(): void {
    const intervalMs = CLEANUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    this.nextCleanupTime = Date.now() + intervalMs;

    this.cleanupTimer = setTimeout(async () => {
      await this.performCleanup();
      this.scheduleNextCleanup();
    }, intervalMs);

    const nextCleanupDate = new Date(this.nextCleanupTime).toLocaleString('zh-CN');
    memoryLogger.info(`下次数据清理时间: ${nextCleanupDate}`, 'DemoMode');
  }

  private async performCleanup(): Promise<void> {
    try {
      memoryLogger.info('开始执行演示模式数据清理...', 'DemoMode');

      await this.clearDatabase();

      await this.clearPortkeyConfig();

      await this.createDemoUser();

      await this.createDefaultGateway();

      memoryLogger.info('演示模式数据清理完成', 'DemoMode');
    } catch (error: any) {
      memoryLogger.error(`演示模式数据清理失败: ${error.message}`, 'DemoMode');
    }
  }

  private async clearDatabase(): Promise<void> {
    const pool = getPool();

    await flushApiRequestBufferNow();

    const tables = [
      'api_requests',
      'model_routing_rules',
      'virtual_keys',
      'models',
      'providers',
      'routing_configs',
      'portkey_gateways',
      'users',
    ];

    const conn = await pool.getConnection();
    try {
      for (const table of tables) {
        try {
          await conn.query(`DELETE FROM ${table}`);
          memoryLogger.info(`已清空表: ${table}`, 'DemoMode');
        } catch (error: any) {
          memoryLogger.error(`清空表 ${table} 失败: ${error.message}`, 'DemoMode');
        }
      }
    } finally {
      conn.release();
    }
  }

  private async clearPortkeyConfig(): Promise<void> {
    try {
      const emptyConfig = {
        credentials: {},
        virtual_keys: {},
      };

      await writeFile(
        appConfig.portkeyConfigPath,
        JSON.stringify(emptyConfig, null, 2),
        'utf-8'
      );

      memoryLogger.info('已清空 Portkey 配置文件', 'DemoMode');
    } catch (error: any) {
      memoryLogger.error(`清空 Portkey 配置文件失败: ${error.message}`, 'DemoMode');
    }
  }

  private async createDemoUser(): Promise<void> {
    try {
      await userDb.create({
        id: nanoid(),
        username: DEMO_USERNAME,
        password_hash: hashPassword(DEMO_PASSWORD),
      });

      memoryLogger.info(`已创建演示用户: ${DEMO_USERNAME}`, 'DemoMode');
    } catch (error: any) {
      memoryLogger.error(`创建演示用户失败: ${error.message}`, 'DemoMode');
    }
  }

  private async createDefaultGateway(): Promise<void> {
    memoryLogger.info('演示模式已启用,跳过创建默认 Gateway (已迁移至 LiteLLM SDK)', 'DemoMode');
  }

  getNextCleanupTime(): number {
    return this.nextCleanupTime;
  }

  isEnabled(): boolean {
    return appConfig.demoMode;
  }
}

export const demoModeService = new DemoModeService();

