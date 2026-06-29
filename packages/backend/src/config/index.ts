import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { z } from 'zod'
import { memoryLogger } from '../services/logger.js'
import { virtualKeyQueueService } from '../services/virtual-key-queue.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
const envCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(currentDir, '../../../.env'),
  resolve(currentDir, '../.env'),
  resolve(currentDir, '../../../../.env'),
  resolve(currentDir, '../../.env')
]

for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    config({ path: envPath })
    break
  }
}

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  JWT_SECRET: z.string().min(32),
  API_REQUEST_LOG_RETENTION_DAYS: z.string().default('14'),
  PUBLIC_URL: z.string().optional(),
  MYSQL_HOST: z.string().default('localhost'),
  MYSQL_PORT: z.string().default('3306'),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string(),
  MYSQL_DATABASE: z.string().default('llm_gateway'),
  MYSQL_CONNECTION_LIMIT: z.string().default('30'),
  GEO_IP_ENABLED: z.string().optional(),
  QUEUE_MAX_CONCURRENCY: z.string().default('20'),
  QUEUE_MAX_SIZE: z.string().default('200'),
  QUEUE_TIMEOUT_MS: z.string().default('30000'),
})

const env = envSchema.parse(process.env)

const port = parseInt(env.PORT, 10)
const defaultPublicUrl = env.PUBLIC_URL || `http://localhost:${port}`

function parsePositiveInt(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

const connectionLimit = parsePositiveInt(env.MYSQL_CONNECTION_LIMIT, 30)

export const appConfig = {
  port,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  jwtSecret: env.JWT_SECRET,
  apiRequestLogRetentionDays: parseInt(env.API_REQUEST_LOG_RETENTION_DAYS, 10),
  publicUrl: defaultPublicUrl,
  defaultPublicUrl,
  geoIpEnabled: env.GEO_IP_ENABLED !== 'false',
  mysql: {
    host: env.MYSQL_HOST,
    port: parseInt(env.MYSQL_PORT, 10),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectionLimit,
  },
  queue: {
    maxConcurrency: parseInt(env.QUEUE_MAX_CONCURRENCY, 10),
    maxQueueSize: parseInt(env.QUEUE_MAX_SIZE, 10),
    queueTimeoutMs: parseInt(env.QUEUE_TIMEOUT_MS, 10)
  }
}

virtualKeyQueueService.configure(appConfig.queue)

export function validatePublicUrl(url: string): { valid: boolean; error?: string } {
  if (!url || !url.trim()) {
    return { valid: false, error: 'LLM Gateway URL 不能为空' }
  }

  try {
    new URL(url)
    return { valid: true }
  } catch (error: unknown) {
    memoryLogger.error(
      `URL 验证失败: ${error instanceof Error ? error.message : String(error)}`,
      'config',
      { url }
    )
    return { valid: false, error: 'LLM Gateway URL 格式无效，请输入有效的 URL（例如: http://example.com:3000）' }
  }
}

export function setPublicUrl(url: string): void {
  appConfig.publicUrl = url
}
