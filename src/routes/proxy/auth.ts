import { virtualKeyDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';

export interface VirtualKeyAuthResult {
  virtualKey: any;
  virtualKeyValue: string;
}

export interface AuthError {
  error: {
    code: number;
    body: {
      error: {
        message: string;
        type: string;
        param: null;
        code: string;
      };
    };
  };
}

/**
 * 从请求头中提取用于虚拟密钥认证的 header
 * 支持：
 * - Authorization: Bearer <virtual_key>
 * - x-google-api-key: <virtual_key>
 * - x-goog-api-key: <virtual_key>
 * - x-api-key: <virtual_key>
 * 这些头通常由标准 SDK（如 Gemini、Claude）发送，这里将它们映射为虚拟密钥认证。
 */
export function extractVirtualKeyAuthHeader(headers: Record<string, any> | undefined): string | undefined {
  if (!headers) return undefined;

  // 优先使用标准 Authorization 头
  const authHeader = (headers as any).authorization || (headers as any).Authorization;
  if (typeof authHeader === 'string' && authHeader.trim() !== '') {
    return authHeader;
  }

  // Fastify 默认会把 header 名转换为小写，这里统一做一次降级
  const lowered: Record<string, any> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = value;
  }

  const candidate =
    lowered['x-google-api-key'] ||
    lowered['x-goog-api-key'] ||
    lowered['x-api-key'];

  if (typeof candidate === 'string' && candidate.trim() !== '') {
    // 这里记录一下，方便排查认证来源
    memoryLogger.info('Using provider-style API key header as virtual key for authentication', 'Proxy');
    return `Bearer ${candidate.trim()}`;
  }

  return undefined;
}



export async function authenticateVirtualKey(authHeader: string | undefined): Promise<VirtualKeyAuthResult | AuthError> {
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: {
        code: 401,
        body: {
          error: {
            message: 'Missing authentication',
            type: 'invalid_request_error',
            param: null,
            code: 'missing_authorization'
          }
        }
      }
    };
  }

  const token = authHeader.substring(7).trim();
  const virtualKeyValue = token;
  const virtualKey = await virtualKeyDb.getByKeyValue(virtualKeyValue);
  if (!virtualKey) {
    memoryLogger.warn(`Virtual key not found: ${virtualKeyValue}`, 'Proxy');
    return {
      error: {
        code: 401,
        body: {
          error: {
            message: 'Invalid virtual key',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key'
          }
        }
      }
    };
  }

  if (!virtualKey.enabled) {
    memoryLogger.warn(`Virtual key disabled: ${virtualKeyValue}`, 'Proxy');
    return {
      error: {
        code: 403,
        body: {
          error: {
            message: 'Virtual key has been disabled',
            type: 'invalid_request_error',
            param: null,
            code: 'api_key_disabled'
          }
        }
      }
    };
  }

  return { virtualKey, virtualKeyValue };
}

export function getModelIdsFromVirtualKey(virtualKey: any): string[] {
  const modelIds: string[] = [];

  if (virtualKey.model_id) {
    modelIds.push(virtualKey.model_id);
  }

  if (virtualKey.model_ids) {
    try {
      const parsedModelIds = JSON.parse(virtualKey.model_ids);
      if (Array.isArray(parsedModelIds)) {
        modelIds.push(...parsedModelIds);
      }
    } catch (e) {
      memoryLogger.error(`Failed to parse model_ids: ${e}`, 'Proxy');
    }
  }

  return [...new Set(modelIds)];
}

