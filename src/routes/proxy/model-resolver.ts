import { FastifyRequest } from 'fastify';
import { providerDb, modelDb, routingConfigDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { resolveProviderFromModel, selectRoutingTarget, type RoutingConfig } from './routing.js';

/**
 * 解析模型请求，支持以下格式：
 * - "gpt-4" - 只指定模型名
 * - "gpt-4@OpenAI" - 指定模型名和供应商名
 * - "gpt-4(OpenAI)" - 指定模型名和供应商名（括号格式）
 */
interface ParsedModelRequest {
  modelName: string;
  providerName?: string;
}

function parseModelRequest(requestedModel: string): ParsedModelRequest {
  // 尝试解析 model@provider 格式
  const atMatch = requestedModel.match(/^(.+?)@(.+)$/);
  if (atMatch) {
    return {
      modelName: atMatch[1].trim(),
      providerName: atMatch[2].trim()
    };
  }

  // 尝试解析 model(provider) 格式
  const parenMatch = requestedModel.match(/^(.+?)\((.+?)\)$/);
  if (parenMatch) {
    return {
      modelName: parenMatch[1].trim(),
      providerName: parenMatch[2].trim()
    };
  }

  // 默认只有模型名
  return {
    modelName: requestedModel.trim()
  };
}

export interface ModelResolutionResult {
  provider: any;
  providerId: string;
  currentModel?: any;
  excludeProviders?: Set<string>;
  canRetry?: boolean; // 是否支持重试（仅智能路由模式）
  modelId?: string; // 用于重试时重新解析
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
    const model = await modelDb.getById(virtualKey.model_id);
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
      // 如果路由返回了 resolvedModel，使用它覆盖 currentModel
      if (result.resolvedModel) {
        currentModel = result.resolvedModel;
      }

      // 检查是否是智能路由（loadbalance/hash/affinity），如果是则支持重试
      const canRetry = !!(model.is_virtual && model.routing_config_id && result.excludeProviders);

      return {
        provider,
        providerId: providerId!,
        currentModel,
        excludeProviders: result.excludeProviders,
        canRetry,
        modelId: virtualKey.model_id
      };
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
        const parsedRequest = parseModelRequest(requestedModel);

        // 强制要求必须指定供应商
        if (!parsedRequest.providerName) {
          memoryLogger.error(`模型格式错误: ${requestedModel}，必须使用 "模型名@供应商名" 格式`, 'ModelResolver');
          return {
            code: 400,
            body: {
              error: {
                message: `Invalid model format: "${requestedModel}". Must use "model@provider" format (e.g., "gpt-4@OpenAI")`,
                type: 'invalid_request_error',
                param: null,
                code: 'invalid_model_format'
              }
            }
          };
        }

        for (const modelId of parsedModelIds) {
          const model = await modelDb.getById(modelId);
          if (!model) continue;

          // 检查模型名称是否匹配
          const modelNameMatch = model.model_identifier === parsedRequest.modelName ||
                                 model.name === parsedRequest.modelName;

          if (!modelNameMatch) continue;

          // 对于虚拟模型（智能路由），只匹配模型名即可（因为它没有固定的 provider_id）
          if (model.is_virtual === 1 && (model.routing_config_id || model.expert_routing_id)) {
            targetModelId = modelId;
            memoryLogger.info(
              `虚拟模型匹配成功: ${parsedRequest.modelName}@${parsedRequest.providerName} -> ${model.name} (智能路由)`,
              'ModelResolver'
            );
            break;
          }

          // 对于普通模型，必须同时匹配模型名和供应商名
          if (model.provider_id) {
            const provider = await providerDb.getById(model.provider_id);
            if (provider && provider.name === parsedRequest.providerName) {
              targetModelId = modelId;
              memoryLogger.info(
                `模型匹配成功: ${parsedRequest.modelName}@${parsedRequest.providerName} -> ${model.name}`,
                'ModelResolver'
              );
              break;
            }
          } else {
            // 普通模型但没有 provider_id，记录警告
            memoryLogger.warn(
              `模型 ${model.name} (${modelId}) 没有关联供应商，跳过`,
              'ModelResolver'
            );
          }
        }

        // 如果没有找到匹配的模型，记录错误
        if (!targetModelId) {
          memoryLogger.error(
            `未找到匹配的模型: ${parsedRequest.modelName}@${parsedRequest.providerName}`,
            'ModelResolver'
          );
          return {
            code: 404,
            body: {
              error: {
                message: `Model not found: ${parsedRequest.modelName}@${parsedRequest.providerName}. Please check your virtual key configuration.`,
                type: 'invalid_request_error',
                param: null,
                code: 'model_not_found'
              }
            }
          };
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

      const model = await modelDb.getById(targetModelId);
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
        // 如果路由返回了 resolvedModel，使用它覆盖 currentModel
        if (result.resolvedModel) {
          currentModel = result.resolvedModel;
        }

        // 检查是否是智能路由（loadbalance/hash/affinity），如果是则支持重试
        const canRetry = !!(model.is_virtual && model.routing_config_id && result.excludeProviders);

        return {
          provider,
          providerId: providerId!,
          currentModel,
          excludeProviders: result.excludeProviders,
          canRetry,
          modelId: targetModelId
        };
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
    provider = await providerDb.getById(virtualKey.provider_id);
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

/**
 * 智能路由重试：使用 excludeProviders 重新解析 provider
 */
export async function retrySmartRouting(
  virtualKey: any,
  request: FastifyRequest,
  modelId: string,
  excludeProviders: Set<string>
): Promise<ModelResolutionResult | ModelResolutionError> {
  const model = await modelDb.getById(modelId);
  if (!model) {
    memoryLogger.error(`Model not found for retry: ${modelId}`, 'Proxy');
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

  try {
    // 调用 resolveProviderFromModel，传入 excludeProviders
    const result = await resolveProviderFromModel(model, request as any, virtualKey.id);

    // 使用 excludeProviders 重新选择
    const retryResult = await resolveSmartRoutingWithExclude(
      model,
      request as any,
      virtualKey.id,
      excludeProviders
    );

    if (!retryResult) {
      throw new Error('No more available targets for retry');
    }

    let currentModel = model;
    if (retryResult.resolvedModel) {
      currentModel = retryResult.resolvedModel;
    }

    // 检查是否还有更多可用目标（简单判断：已排除数量 < targets 数量）
    const canRetry = !!retryResult.excludeProviders;

    return {
      provider: retryResult.provider,
      providerId: retryResult.providerId!,
      currentModel,
      excludeProviders: retryResult.excludeProviders,
      canRetry,
      modelId
    };
  } catch (error: any) {
    memoryLogger.error(`Smart routing retry failed: ${error.message}`, 'Proxy');
    return {
      code: 500,
      body: {
        error: {
          message: error.message || 'Smart routing retry failed',
          type: 'internal_error',
          param: null,
          code: 'smart_routing_retry_error'
        }
      }
    };
  }
}

async function resolveSmartRoutingWithExclude(
  model: any,
  request: any,
  virtualKeyId?: string,
  excludeProviders?: Set<string>
): Promise<any> {
  const { resolveSmartRouting } = await import('./routing.js');
  return await resolveSmartRouting(model, request, virtualKeyId, excludeProviders);
}

