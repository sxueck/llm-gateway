import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_PATH: z.string().default('./data/gateway.db'),
  PORTKEY_CONFIG_PATH: z.string().default('./portkey-config/conf.json'),
  LOG_LEVEL: z.string().default('info'),
  JWT_SECRET: z.string().min(32),
  API_REQUEST_LOG_RETENTION_DAYS: z.string().default('3'),
});

const env = envSchema.parse(process.env);

export const appConfig = {
  port: parseInt(env.PORT, 10),
  nodeEnv: env.NODE_ENV,
  dbPath: env.DB_PATH,
  portkeyConfigPath: env.PORTKEY_CONFIG_PATH,
  logLevel: env.LOG_LEVEL,
  jwtSecret: env.JWT_SECRET,
  apiRequestLogRetentionDays: parseInt(env.API_REQUEST_LOG_RETENTION_DAYS, 10),
};

