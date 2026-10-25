import { FastifyReply } from 'fastify';
import { memoryLogger } from '../services/logger.js';
import { EmptyOutputError } from '../errors/empty-output-error.js';
import { writeWithBackpressure } from './stream-guards.js';

export class StreamBuffer {
  private pendingChunks: string[] = [];
  private buffering = true;
  private reply: FastifyReply;

  constructor(reply: FastifyReply) {
    this.reply = reply;
  }

  private async writeDirect(chunk: string): Promise<void> {
    if (this.reply.raw.destroyed || this.reply.raw.writableEnded) {
      return;
    }
    await writeWithBackpressure(this.reply.raw, chunk);
  }

  async enqueue(chunk: string): Promise<void> {
    if (this.buffering) {
      this.pendingChunks.push(chunk);
    } else {
      await this.writeDirect(chunk);
    }
  }

  async flush(): Promise<void> {
    if (!this.buffering) return;
    this.buffering = false;
    while (this.pendingChunks.length > 0) {
      const pending = this.pendingChunks.shift();
      if (pending !== undefined) {
        await this.writeDirect(pending);
      }
    }
  }

  isBuffering(): boolean {
    return this.buffering;
  }

  getBufferedChunks(): string[] {
    return [...this.pendingChunks];
  }
}

export interface StreamRetryConfig<T> {
  source: 'gemini' | 'responses';
  maxRetries: number;
  reply: FastifyReply;
  abortSignal?: AbortSignal;
  detectEmptyOutput: (aggregate: T) => boolean;
  detectBypassCondition: (aggregate: T) => boolean;
  onRetryWarning?: (attempt: number, totalAttempts: number, aggregate: T) => void;
}

export interface StreamProcessor<T> {
  process(buffer: StreamBuffer, abortSignal?: AbortSignal): Promise<T>;
}

export class StreamRetryManager<T> {
  private config: StreamRetryConfig<T>;

  constructor(config: StreamRetryConfig<T>) {
    this.config = config;
  }

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
          // 上游错误等旁路条件即使没有 assistant 输出，也要把缓冲交给客户端
          await buffer.flush();
          finalAggregate = aggregate;
          break;
        }

        // 空输出不 flush，丢弃这次缓冲后再重试
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

export function getRetryLimit(
  envVarName: string,
  defaultValue: number,
  modelAttributes?: any,
  attributeKey?: string
): number {
  // 模型属性优先，其次环境变量，最后默认值
  if (attributeKey && modelAttributes?.[attributeKey] !== undefined) {
    const configured = modelAttributes[attributeKey];
    if (typeof configured === 'number' && Number.isFinite(configured)) {
      return Math.max(0, Math.floor(configured));
    }
  }

  const envValue = process.env[envVarName];
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(parsed, 0);
    }
  }

  return Math.max(defaultValue, 0);
}
