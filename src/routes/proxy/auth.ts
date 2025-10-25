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

export function authenticateVirtualKey(authHeader: string | undefined): VirtualKeyAuthResult | AuthError {
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

  const virtualKeyValue = authHeader.substring(7);
  const virtualKey = virtualKeyDb.getByKeyValue(virtualKeyValue);

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

