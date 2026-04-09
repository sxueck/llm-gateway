import { getDatabase } from '../connection.js';
import { ApiRequestBuffer } from '../types.js';
import { getByteLength, truncateToByteLength } from './string-utils.js';
import { parsePositiveInt } from '../../utils/parse-positive-int.js';

let apiRequestBuffer: ApiRequestBuffer[] = [];
let bufferFlushTimer: NodeJS.Timeout | null = null;
const BUFFER_FLUSH_INTERVAL = 10000;
const BUFFER_MAX_SIZE = 200;
const DEFAULT_MAX_FLUSH_RETRY_ATTEMPTS = 5;

const BUFFER_MAX_FLUSH_RETRY_ATTEMPTS = parsePositiveInt(
  process.env.API_REQUEST_BUFFER_MAX_RETRY_ATTEMPTS,
  DEFAULT_MAX_FLUSH_RETRY_ATTEMPTS
);

const flushRetryAttempts = new Map<string, number>();

function clearRetryAttempts(requests: ApiRequestBuffer[]): void {
  for (const request of requests) {
    flushRetryAttempts.delete(request.id);
  }
}

function requeueRequestsAfterFailure(requests: ApiRequestBuffer[], error: unknown): void {
  const requeueRequests: ApiRequestBuffer[] = [];
  let droppedCount = 0;

  for (const request of requests) {
    const currentAttempts = flushRetryAttempts.get(request.id) || 0;
    const nextAttempts = currentAttempts + 1;

    if (nextAttempts >= BUFFER_MAX_FLUSH_RETRY_ATTEMPTS) {
      flushRetryAttempts.delete(request.id);
      droppedCount++;
      continue;
    }

    flushRetryAttempts.set(request.id, nextAttempts);
    requeueRequests.push(request);
  }

  if (requeueRequests.length > 0) {
    apiRequestBuffer.unshift(...requeueRequests);
  }

  const errorMessage = error instanceof Error ? error.message : String(error);

  if (requeueRequests.length > 0) {
    console.error(
      `[数据库] API 请求日志写入失败，已回灌 ${requeueRequests.length} 条，丢弃 ${droppedCount} 条，错误: ${errorMessage}`
    );
  } else {
    console.error(
      `[数据库] API 请求日志写入失败，已达到最大重试次数并丢弃 ${droppedCount} 条，错误: ${errorMessage}`
    );
  }
}

export function startBufferFlush() {
  if (bufferFlushTimer) {
    clearInterval(bufferFlushTimer);
  }

  bufferFlushTimer = setInterval(() => {
    flushApiRequestBuffer();
  }, BUFFER_FLUSH_INTERVAL);
}

export function stopBufferFlush() {
  if (bufferFlushTimer) {
    clearInterval(bufferFlushTimer);
    bufferFlushTimer = null;
  }
}

export async function flushApiRequestBuffer() {
  if (apiRequestBuffer.length === 0) {
    return;
  }

  const now = Date.now();
  const requests = [...apiRequestBuffer];
  apiRequestBuffer = [];

  const pool = getDatabase();
  let conn: Awaited<ReturnType<typeof pool.getConnection>> | null = null;

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const values: any[] = [];
    const placeholders: string[] = [];
    const payloadValues: any[] = [];
    const payloadPlaceholders: string[] = [];

    // 限制每个字段最大 5000 字节
    const MAX_COLUMN_BYTES = 5000;

    for (const request of requests) {
      let requestBody = request.request_body;
      let responseBody = request.response_body;
      let errorMessage = request.error_message;
      let ip = request.ip;
      let userAgent = request.user_agent;

      if (ip && ip.length > 45) {
        ip = ip.substring(0, 45);
      }

      if (requestBody && getByteLength(requestBody) > MAX_COLUMN_BYTES) {
        requestBody = truncateToByteLength(requestBody, MAX_COLUMN_BYTES);
      }
      if (responseBody && getByteLength(responseBody) > MAX_COLUMN_BYTES) {
        responseBody = truncateToByteLength(responseBody, MAX_COLUMN_BYTES);
      }
      if (errorMessage && getByteLength(errorMessage) > MAX_COLUMN_BYTES) {
        errorMessage = truncateToByteLength(errorMessage, MAX_COLUMN_BYTES);
      }

      if (userAgent && getByteLength(userAgent) > 500) {
        userAgent = truncateToByteLength(userAgent, 500);
      }

      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        request.id,
        request.virtual_key_id || null,
        request.provider_id || null,
        request.model || null,
        request.prompt_tokens || 0,
        request.completion_tokens || 0,
        request.cached_tokens || 0,
        request.status,
        request.response_time || null,
        request.tffb_ms ?? null,
        errorMessage || null,
        request.request_params_json || null,
        request.response_meta_json || null,
        request.cache_hit || 0,
        request.request_type || 'chat',
        request.compression_original_tokens || null,
        request.compression_saved_tokens || null,
        ip || null,
        userAgent || null,
        now
      );

      if (requestBody || responseBody) {
        payloadPlaceholders.push('(?, ?, ?, ?)');
        payloadValues.push(
          request.id,
          requestBody || null,
          responseBody || null,
          now
        );
      }
    }

    if (placeholders.length > 0) {
      await conn.query(
        `INSERT INTO api_requests (
          id, virtual_key_id, provider_id, model,
          prompt_tokens, completion_tokens, cached_tokens,
          status, response_time, tffb_ms, error_message, request_params_json, response_meta_json, cache_hit,
          request_type, compression_original_tokens, compression_saved_tokens, ip, user_agent, created_at
        ) VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    if (payloadPlaceholders.length > 0) {
      await conn.query(
        `INSERT INTO api_request_payloads (
          request_id, request_body, response_body, created_at
        ) VALUES ${payloadPlaceholders.join(', ')}`,
        payloadValues
      );
    }

    await conn.commit();
    clearRetryAttempts(requests);
  } catch (error: any) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (_rollbackError) {
      }
    }

    requeueRequestsAfterFailure(requests, error);
  } finally {
    conn?.release();
  }
}

export function addToBuffer(request: ApiRequestBuffer): void {
  apiRequestBuffer.push(request);
}

export function getBufferSize(): number {
  return apiRequestBuffer.length;
}

export function getMaxBufferSize(): number {
  return BUFFER_MAX_SIZE;
}

export function shouldFlush(): boolean {
  return apiRequestBuffer.length >= BUFFER_MAX_SIZE;
}
