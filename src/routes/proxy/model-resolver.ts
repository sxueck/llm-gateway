import { FastifyRequest } from 'fastify';
import { providerDb, modelDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { resolveProviderFromModel } from './routing.js';

export interface ModelResolutionResult {
  provider: any;
  providerId: string;
  currentModel?: any;
}

export interface ModelResolutionError {
  code: number;
  body: {
    error: {
      message: string;
      type: string;
      param: null;
      code: string;
    };
  };
}

export async function resolveModelAndProvider(
  virtualKey: any,
  request: FastifyRequest,
  virtualKeyValue: string
): Promise<ModelResolutionResult | ModelResolutionError> {
  let provider;
  let currentModel;
  let providerId: string | undefined;

  if (virtualKey.model_id) {
    const model = modelDb.getById(virtualKey.model_id);
    if (!model) {
      memoryLogger.error(`Model not found: ${virtualKey.model_id}`, 'Proxy');
      return {
        code: 500,
        body: {
          error: {
            message: 'Model config not found',
            type: 'internal_error',
            param: null,
            code: 'model_not_found'
          }
        }
      };
    }

    currentModel = model;

    try {
      const result = await resolveProviderFromModel(model, request as any, virtualKey.id);
      provider = result.provider;
      providerId = result.providerId;
    } catch (routingError: any) {
      memoryLogger.error(`Smart routing failed: ${routingError.message}`, 'Proxy');
      return {
        code: 500,
        body: {
          error: {
            message: routingError.message || 'Smart routing failed',
            type: 'internal_error',
            param: null,
            code: 'smart_routing_error'
          }
        }
      };
    }
  } else if (virtualKey.model_ids) {
    try {
      const parsedModelIds = JSON.parse(virtualKey.model_ids);
      if (!Array.isArray(parsedModelIds) || parsedModelIds.length === 0) {
        memoryLogger.error(`Invalid model_ids config for virtual key: ${virtualKeyValue}`, 'Proxy');
        return {
          code: 500,
          body: {
            error: {
              message: 'Invalid virtual key model config',
              type: 'internal_error',
              param: null,
              code: 'invalid_model_config'
            }
          }
        };
      }

      const requestedModel = (request.body as any)?.model;
      let targetModelId: string | undefined;

      if (requestedModel) {
        for (const modelId of parsedModelIds) {
          const model = modelDb.getById(modelId);
          if (model && (model.model_identifier === requestedModel || model.name === requestedModel)) {
            targetModelId = modelId;
            break;
          }
        }
      }

      if (!targetModelId) {
        targetModelId = parsedModelIds[0];
      }

      if (!targetModelId) {
        memoryLogger.error(`Cannot determine target model`, 'Proxy');
        return {
          code: 500,
          body: {
            error: {
              message: 'Cannot determine target model',
              type: 'internal_error',
              param: null,
              code: 'model_not_determined'
            }
          }
        };
      }

      const model = modelDb.getById(targetModelId);
      if (!model) {
        memoryLogger.error(`Model not found: ${targetModelId}`, 'Proxy');
        return {
          code: 500,
          body: {
            error: {
              message: 'Model config not found',
              type: 'internal_error',
              param: null,
              code: 'model_not_found'
            }
          }
        };
      }

      currentModel = model;

      try {
        const result = await resolveProviderFromModel(model, request as any, virtualKey.id);
        provider = result.provider;
        providerId = result.providerId;
      } catch (routingError: any) {
        memoryLogger.error(`Smart routing failed: ${routingError.message}`, 'Proxy');
        return {
          code: 500,
          body: {
            error: {
              message: routingError.message || 'Smart routing failed',
              type: 'internal_error',
              param: null,
              code: 'smart_routing_error'
            }
          }
        };
      }
    } catch (e) {
      memoryLogger.error(`Failed to parse model_ids: ${e}`, 'Proxy');
      return {
        code: 500,
        body: {
          error: {
            message: 'Failed to parse virtual key model config',
            type: 'internal_error',
            param: null,
            code: 'model_config_parse_error'
          }
        }
      };
    }
  } else if (virtualKey.provider_id) {
    provider = providerDb.getById(virtualKey.provider_id);
    if (!provider) {
      memoryLogger.error(`Provider not found: ${virtualKey.provider_id}`, 'Proxy');
      return {
        code: 500,
        body: {
          error: {
            message: 'Provider config not found',
            type: 'internal_error',
            param: null,
            code: 'provider_not_found'
          }
        }
      };
    }

    providerId = virtualKey.provider_id;
  } else {
    memoryLogger.error(`Virtual key has no model or provider configured: ${virtualKeyValue}`, 'Proxy');
    return {
      code: 500,
      body: {
        error: {
          message: 'Incomplete virtual key config',
          type: 'internal_error',
          param: null,
          code: 'invalid_key_config'
        }
      }
    };
  }

  if (!provider) {
    memoryLogger.error(`Provider not found`, 'Proxy');
    return {
      code: 500,
      body: {
        error: {
          message: 'Provider config not found',
          type: 'internal_error',
          param: null,
          code: 'provider_not_found'
        }
      }
    };
  }

  return {
    provider,
    providerId: providerId!,
    currentModel
  };
}

