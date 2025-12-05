import { FastifyReply } from 'fastify';
import { memoryLogger } from '../services/logger.js';
import { EmptyOutputError } from '../errors/empty-output-error.js';

/**
 * 流式缓冲管理器 - 处理背压和缓冲逻辑
 */
export class StreamBuffer {
  private pendingChunks: string[] = [];
  private buffering = true;
  private reply: FastifyReply;

  constructor(reply: FastifyReply) {
    this.reply = reply;
  }

  /**
   * 直接写入到响应流，处理背压
   */
  private async writeDirect(chunk: string): Promise<void> {
    if (this.reply.raw.destroyed || this.reply.raw.writableEnded) {
      return;
    }
    if (!this.reply.raw.write(chunk)) {
      await new Promise<void>((resolve) => {
        this.reply.raw.once('drain', resolve);
      });
    }
  }

  /**
   * 入队一个chunk，根据缓冲状态决定是否立即写入
   */
  async enqueue(chunk: string): Promise<void> {
    if (this.buffering) {
      this.pendingChunks.push(chunk);
    } else {
      await this.writeDirect(chunk);
    }
  }

  /**
   * 刷新所有待处理的chunks到响应流
   */
  async flush(): Promise<void> {
    if (!this.buffering) return;
    this.buffering = false;
    while (this.pendingChunks.length > 0) {
      const pending = this.pendingChunks.shift();
      if (pending) {
        await this.writeDirect(pending);
      }
    }
  }

  /**
   * 检查是否仍在缓冲
   */
  isBuffering(): boolean {
    return this.buffering;
  }

  /**
   * 获取已缓冲的chunks（用于返回值）
   */
  getBufferedChunks(): string[] {
    return [...this.pendingChunks];
  }
}

/**
 * 流式重试配置
 */
export interface StreamRetryConfig<T> {
  source: 'gemini' | 'responses';
  maxRetries: number;
  reply: FastifyReply;
  abortSignal?: AbortSignal;
  detectEmptyOutput: (aggregate: T) => boolean;
  detectBypassCondition: (aggregate: T) => boolean;
  onRetryWarning?: (attempt: number, totalAttempts: number, aggregate: T) => void;
}

/**
 * 流式处理器 - 处理单次流式尝试
 */
export interface StreamProcessor<T> {
  /**
   * 处理流式数据，返回聚合结果
   */
  process(buffer: StreamBuffer, abortSignal?: AbortSignal): Promise<T>;
}

/**
 * 通用流式重试管理器
 */
export class StreamRetryManager<T> {
  private config: StreamRetryConfig<T>;

  constructor(config: StreamRetryConfig<T>) {
    this.config = config;
  }

  /**
   * 执行带重试的流式处理
   */
  async executeWithRetry(processor: StreamProcessor<T>): Promise<T> {
    const totalAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastEmptyError: EmptyOutputError | null = null;
    let finalAggregate: T | null = null;

    attemptLoop: for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (this.config.abortSignal?.aborted) {
        const abortError = new Error('Request aborted');
        (abortError as any).name = 'AbortError';
        throw abortError;
      }

      const buffer = new StreamBuffer(this.config.reply);

      try {
        const aggregate = await processor.process(buffer, this.config.abortSignal);

        const isEmpty = this.config.detectEmptyOutput(aggregate);
        const shouldBypass = this.config.detectBypassCondition(aggregate);

        if (!isEmpty || shouldBypass) {
          // 成功获得输出，或遇到应该旁路的条件
          await buffer.flush();
          finalAggregate = aggregate;
          break;
        }

        // 检测到空输出，准备重试
        lastEmptyError = new EmptyOutputError(
          `${this.config.source === 'gemini' ? 'Gemini' : 'Responses API'} stream completed without assistant output`,
          {
            source: this.config.source,
            attempt,
            totalAttempts,
            ...(aggregate as any),
          }
        );

        if (this.config.onRetryWarning) {
          this.config.onRetryWarning(attempt, totalAttempts, aggregate);
        } else {
          memoryLogger.warn(
            `[${this.config.source}] 未检测到输出，准备重试 | attempt ${attempt}/${totalAttempts}`,
            'StreamRetry'
          );
        }

        continue attemptLoop;
      } catch (error: any) {
        if (error.name === 'AbortError' || this.config.abortSignal?.aborted) {
          memoryLogger.info(`[${this.config.source}] 流式请求被用户取消`, 'StreamRetry');
        }
        throw error;
      }
    }

    if (!finalAggregate) {
      const errorToThrow =
        lastEmptyError ||
        new EmptyOutputError(
          `${this.config.source === 'gemini' ? 'Gemini' : 'Responses API'} stream ended without assistant output`,
          {
            source: this.config.source,
            totalAttempts,
          }
        );
      memoryLogger.error(
        `[${this.config.source}] 多次尝试仍为空返回，终止请求 | attempts=${totalAttempts}`,
        'StreamRetry'
      );
      throw errorToThrow;
    }

    return finalAggregate;
  }
}

/**
 * 获取重试限制的辅助函数
 */
export function getRetryLimit(
  envVarName: string,
  defaultValue: number,
  modelAttributes?: any,
  attributeKey?: string
): number {
  // 优先从模型属性读取
  if (attributeKey && modelAttributes?.[attributeKey] !== undefined) {
    const configured = modelAttributes[attributeKey];
    if (typeof configured === 'number' && Number.isFinite(configured)) {
      return Math.max(0, Math.floor(configured));
    }
  }

  // 其次从环境变量读取
  const envValue = process.env[envVarName];
  if (envValue !== undefined) {
    return Math.max(parseInt(envValue, 10) || 0, 0);
  }

  // 最后使用默认值
  return Math.max(defaultValue, 0);
}