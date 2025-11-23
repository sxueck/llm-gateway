import { healthTargetDb, healthRunDb, modelDb, systemConfigDb, virtualKeyDb, HealthTarget } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { nanoid } from 'nanoid';
import fetch from 'node-fetch';
import { appConfig } from '../config/index.js';
import { probeService } from './probe-service.js';

interface CheckConfig {
  timeout?: number;
  maxRetries?: number;
  concurrencyLimit?: number;
}

interface HealthCheckResult {
  success: boolean;
  latencyMs: number;
  errorType?: string;
  errorMessage?: string;
  requestId?: string;
}

class HealthCheckerService {
  private checkTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly CHECK_INTERVAL_MS = 30000; // 每30秒扫描一次待检查目标
  private activeTasks = 0;
  private readonly MAX_CONCURRENT_CHECKS = 5; // 全局最大并发数

  async start() {
    if (this.isRunning) {
      memoryLogger.warn('健康检查服务已在运行', 'HealthChecker');
      return;
    }

    this.isRunning = true;
    memoryLogger.info('健康检查服务启动', 'HealthChecker');

    // 立即执行一次检查
    this.runCheckCycle();

    // 定时扫描
    this.checkTimer = setInterval(() => {
      this.runCheckCycle();
    }, this.CHECK_INTERVAL_MS);
  }

  async stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.isRunning = false;
    memoryLogger.info('健康检查服务停止', 'HealthChecker');
  }

  private async runCheckCycle() {
    try {
      const now = Date.now();
      const dueTargets = await healthTargetDb.getDueTargets(now);

      if (dueTargets.length === 0) {
        return;
      }

      memoryLogger.info(`发现 ${dueTargets.length} 个待检查目标`, 'HealthChecker');

      // 控制并发执行
      for (const target of dueTargets) {
        // 等待空闲槽位
        while (this.activeTasks >= this.MAX_CONCURRENT_CHECKS) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.activeTasks++;
        this.executeHealthCheck(target)
          .catch(err => {
            memoryLogger.error(`健康检查执行失败: ${err.message}`, 'HealthChecker');
          })
          .finally(() => {
            this.activeTasks--;
          });
      }
    } catch (error: any) {
      memoryLogger.error(`健康检查周期执行失败: ${error.message}`, 'HealthChecker');
    }
  }

  private async executeHealthCheck(target: HealthTarget): Promise<void> {
    const startTime = Date.now();
    const requestId = nanoid();

    try {
      memoryLogger.info(`开始检查目标: ${target.name} (${target.type})`, 'HealthChecker');

      // 解析配置
      const config: CheckConfig = target.check_config ? JSON.parse(target.check_config) : {};
      const timeout = config.timeout || 20000; // 默认20秒超时
      const maxRetries = config.maxRetries || 1;

      // 获取检查提示词
      const prompt = target.check_prompt || 'Say "OK"';

      // 执行健康检查
      let result: HealthCheckResult | null = null;
      let lastError: any = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await this.performCheck(target, prompt, timeout, requestId);
          if (result.success) {
            break; // 成功则退出重试
          }
          lastError = new Error(result.errorMessage || '未知错误');
        } catch (err: any) {
          lastError = err;
          memoryLogger.warn(`目标 ${target.name} 检查失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${err.message}`, 'HealthChecker');
        }
      }

      // 记录结果
      if (!result) {
        result = {
          success: false,
          latencyMs: Date.now() - startTime,
          errorType: 'unknown',
          errorMessage: lastError?.message || '健康检查失败',
        };
      }

      await healthRunDb.create({
        id: nanoid(),
        target_id: target.id,
        status: result.success ? 'success' : 'error',
        latency_ms: result.latencyMs,
        error_type: result.errorType || null,
        error_message: result.errorMessage || null,
        request_id: result.requestId || requestId,
      });

      const statusText = result.success ? '成功' : '失败';
      memoryLogger.info(
        `目标 ${target.name} 检查${statusText}, 耗时: ${result.latencyMs}ms`,
        'HealthChecker'
      );
    } catch (error: any) {
      memoryLogger.error(`目标 ${target.name} 检查异常: ${error.message}`, 'HealthChecker');

      // 记录异常结果
      await healthRunDb.create({
        id: nanoid(),
        target_id: target.id,
        status: 'error',
        latency_ms: Date.now() - startTime,
        error_type: 'exception',
        error_message: error.message,
        request_id: requestId,
      });
    }
  }

  private async performCheck(
    target: HealthTarget,
    prompt: string,
    timeout: number,
    requestId: string
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      const model = await modelDb.getById(target.target_id);
      if (!model) {
        return {
          success: false,
          latencyMs: Date.now() - startTime,
          errorType: 'not_found',
          errorMessage: `目标模型不存在: ${target.target_id}`,
        };
      }
      if (!model.enabled) {
        return {
          success: false,
          latencyMs: Date.now() - startTime,
          errorType: 'disabled',
          errorMessage: '目标模型已禁用',
        };
      }

      const gatewayUrl = appConfig.publicUrl || `http://localhost:${appConfig.port}`;
      const persistentCfg = await systemConfigDb.get('persistent_monitoring_enabled');
      const isPersistent = persistentCfg ? persistentCfg.value === 'true' : false;
      let monitoringKeyValue: string | null = null;

      if (isPersistent) {
        const keyIdCfg = await systemConfigDb.get('monitoring_virtual_key_id');
        if (keyIdCfg) {
          const key = await virtualKeyDb.getById(keyIdCfg.value);
          if (key && key.enabled === 1) {
            monitoringKeyValue = key.key_value;
          }
        }
      }

      if (!monitoringKeyValue) {
        return {
          success: false,
          latencyMs: Date.now() - startTime,
          errorType: 'invalid_virtual_key',
          errorMessage: '监控虚拟密钥无效或未启用',
          requestId,
        };
      }

      const outcome = await probeService.probeModelViaGateway({
        protocol: (model.protocol || 'openai') as any,
        modelName: model.name,
        gatewayUrl,
        bearerKey: monitoringKeyValue,
        prompt,
        timeoutMs: timeout,
      });

      return {
        success: outcome.success,
        latencyMs: outcome.latencyMs,
        errorType: outcome.errorType,
        errorMessage: outcome.errorMessage,
        requestId,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;

      let errorType = 'unknown';
      let errorMessage = error.message;

      if (error.name === 'AbortError') {
        errorType = 'timeout';
        errorMessage = `请求超时 (>${timeout}ms)`;
      } else if (error.code === 'ECONNREFUSED') {
        errorType = 'connection_refused';
        errorMessage = '连接被拒绝';
      } else if (error.code === 'ENOTFOUND') {
        errorType = 'dns_error';
        errorMessage = '无法解析主机名';
      }

      return {
        success: false,
        latencyMs,
        errorType,
        errorMessage,
        requestId,
      };
    }
  }

  // 手动触发检查某个目标
  async checkTarget(targetId: string): Promise<HealthCheckResult> {
    const target = await healthTargetDb.getById(targetId);
    if (!target) {
      throw new Error(`目标不存在: ${targetId}`);
    }

    const requestId = nanoid();
    const config: CheckConfig = target.check_config ? JSON.parse(target.check_config) : {};
    const timeout = config.timeout || 20000;
    const prompt = target.check_prompt || 'Say "OK"';

    return this.performCheck(target, prompt, timeout, requestId);
  }
}

export const healthCheckerService = new HealthCheckerService();
