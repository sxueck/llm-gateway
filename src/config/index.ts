import { config } from 'dotenv';
import { z } from 'zod';
import { memoryLogger } from '../services/logger.js';

config();

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_PATH: z.string().default('./data/gateway.db'),
  LOG_LEVEL: z.string().default('info'),
  JWT_SECRET: z.string().min(32),
  API_REQUEST_LOG_RETENTION_DAYS: z.string().default('3'),
  PUBLIC_URL: z.string().optional(),
  DEMO_MODE: z.string().optional(),
  MYSQL_HOST: z.string().default('localhost'),
  MYSQL_PORT: z.string().default('3306'),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string(),
  MYSQL_DATABASE: z.string().default('llm_gateway'),
});

const env = envSchema.parse(process.env);

const port = parseInt(env.PORT, 10);
const defaultPublicUrl = env.PUBLIC_URL || `http://localhost:${port}`;

export const appConfig = {
  port,
  nodeEnv: env.NODE_ENV,
  dbPath: env.DB_PATH,
  logLevel: env.LOG_LEVEL,
  jwtSecret: env.JWT_SECRET,
  apiRequestLogRetentionDays: parseInt(env.API_REQUEST_LOG_RETENTION_DAYS, 10),
  publicUrl: defaultPublicUrl,
  defaultPublicUrl,
  demoMode: env.DEMO_MODE === 'true' || env.DEMO_MODE === 'enabled',
  mysql: {
    host: env.MYSQL_HOST,
    port: parseInt(env.MYSQL_PORT, 10),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  },
};

export function validatePublicUrl(url: string): { valid: boolean; error?: string } {
  if (!url || !url.trim()) {
    return { valid: false, error: 'LLM Gateway URL 不能为空' };
  }

  try {
    new URL(url);
    return { valid: true };
  } catch (error: unknown) {
    memoryLogger.error(
      `URL 验证失败: ${error instanceof Error ? error.message : String(error)}`,
      'config',
      { url }
    );
    return { valid: false, error: 'LLM Gateway URL 格式无效，请输入有效的 URL（例如: http://example.com:3000）' };
  }
}

export function setPublicUrl(url: string): void {
  appConfig.publicUrl = url;
}

