import { getDatabase } from '../connection.js';
import { ApiRequestBuffer } from '../types.js';
import { getByteLength, truncateToByteLength } from './string-utils.js';

let apiRequestBuffer: ApiRequestBuffer[] = [];
let bufferFlushTimer: NodeJS.Timeout | null = null;
const BUFFER_FLUSH_INTERVAL = 10000;
const BUFFER_MAX_SIZE = 200;

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
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const values: any[] = [];
    const placeholders: string[] = [];

    // 限制每个字段最大 5000 字节
    const MAX_COLUMN_BYTES = 5000;

    for (const request of requests) {
      let requestBody = request.request_body;
      let responseBody = request.response_body;

      // 最终安全检查：确保不会超过数据库列的最大字节长度
      if (requestBody && getByteLength(requestBody) > MAX_COLUMN_BYTES) {
        requestBody = truncateToByteLength(requestBody, MAX_COLUMN_BYTES);
      }
      if (responseBody && getByteLength(responseBody) > MAX_COLUMN_BYTES) {
        responseBody = truncateToByteLength(responseBody, MAX_COLUMN_BYTES);
      }

      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        request.id,
        request.virtual_key_id || null,
        request.provider_id || null,
        request.model || null,
        request.prompt_tokens || 0,
        request.completion_tokens || 0,
        request.total_tokens || 0,
        request.cached_tokens || 0,
        request.status,
        request.response_time || null,
        request.error_message || null,
        requestBody,
        responseBody,
        request.cache_hit || 0,
        request.request_type || 'chat',
        request.compression_original_tokens || null,
        request.compression_saved_tokens || null,
        now
      );
    }

    if (placeholders.length > 0) {
      await conn.query(
        `INSERT INTO api_requests (
          id, virtual_key_id, provider_id, model,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens,
          status, response_time, error_message, request_body, response_body, cache_hit,
          request_type, compression_original_tokens, compression_saved_tokens, created_at
        ) VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    await conn.commit();
  } catch (error: any) {
    await conn.rollback();
    console.error('[数据库] 批量写入 API 请求日志失败:', error.message);
    // 失败时放回缓冲区
    apiRequestBuffer.unshift(...requests);
  } finally {
    conn.release();
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
