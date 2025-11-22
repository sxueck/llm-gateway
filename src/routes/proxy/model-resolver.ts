import { FastifyRequest } from 'fastify';
import { providerDb, modelDb, routingConfigDb, systemConfigDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { resolveProviderFromModel, selectRoutingTarget, type RoutingConfig } from './routing.js';

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

  // 放宽监控专用密钥限制：健康检查请求可不依赖虚拟密钥已绑定模型
  try {
    const isHealthCheck = String((request.headers['x-health-check'] as any) || '').toLowerCase() === 'true';
    if (isHealthCheck) {
      const monitoringKeyIdCfg = await systemConfigDb.get('monitoring_virtual_key_id');
      if (monitoringKeyIdCfg && monitoringKeyIdCfg.value === virtualKey.id) {
        const requestedModel = (request.body as any)?.model;
        if (!requestedModel) {
          return {
            code: 400,
            body: {
              error: {
                message: 'Missing model for health check',
                type: 'invalid_request_error',
                param: null,
                code: 'missing_model'
              }
            }
          };
        }

        const allModels = await modelDb.getAll();
        const model = (allModels as any[]).find(m =>
          m?.model_identifier === requestedModel || m?.name === requestedModel
        );

        if (!model) {
          memoryLogger.error(`Health check model not found: ${requestedModel}`, 'ModelResolver');
          return {
            code: 404,
            body: {
              error: {
                message: `Model not found for health check: ${requestedModel}`,
                type: 'invalid_request_error',
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

          if (result.resolvedModel) {
            currentModel = result.resolvedModel;
          }

          const canRetry = !!(model.is_virtual && model.routing_config_id && result.excludeProviders);

          return {
            provider,
            providerId: providerId!,
            currentModel,
            excludeProviders: result.excludeProviders,
            canRetry,
            modelId: model.id
          };
        } catch (e: any) {
          memoryLogger.error(`Health check provider resolution failed: ${e.message}`, 'ModelResolver');
          return {
            code: 500,
            body: {
              error: {
                message: e.message || 'Health check resolution failed',
                type: 'internal_error',
                param: null,
                code: 'health_check_resolution_failed'
              }
            }
          };
        }
      }
    }
  } catch (_e) {
    // 忽略健康检查快速路径中的异常，继续走常规分支
  }

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
        // 收集所有匹配的模型
        const matchedModels: Array<{ modelId: string; model: any; provider?: any }> = [];

        for (const modelId of parsedModelIds) {
          const model = await modelDb.getById(modelId);
          if (!model) continue;

          // 检查模型名称是否匹配
          const modelNameMatch = model.model_identifier === requestedModel ||
                                 model.name === requestedModel;

          if (!modelNameMatch) continue;

          // 虚拟模型（智能路由）
          if (model.is_virtual === 1 && (model.routing_config_id || model.expert_routing_id)) {
            matchedModels.push({ modelId, model });
          } else if (model.provider_id) {
            // 普通模型
            const provider = await providerDb.getById(model.provider_id);
            if (provider) {
              matchedModels.push({ modelId, model, provider });
            } else {
              memoryLogger.warn(
                `模型 ${model.name} (${modelId}) 的供应商 ${model.provider_id} 不存在`,
                'ModelResolver'
              );
            }
          } else {
            memoryLogger.warn(
              `模型 ${model.name} (${modelId}) 没有关联供应商且不是虚拟模型`,
              'ModelResolver'
            );
          }
        }

        if (matchedModels.length === 0) {
          memoryLogger.error(`未找到匹配的模型: ${requestedModel}`, 'ModelResolver');
          return {
            code: 404,
            body: {
              error: {
                message: `Model not found: ${requestedModel}. Please check your virtual key configuration.`,
                type: 'invalid_request_error',
                param: null,
                code: 'model_not_found'
              }
            }
          };
        } else if (matchedModels.length === 1) {
          // 只有一个匹配，使用它
          const matched = matchedModels[0];
          targetModelId = matched.modelId;

          const providerInfo = matched.provider
            ? matched.provider.name
            : '智能路由';

          memoryLogger.debug(
            `模型匹配成功: ${requestedModel} -> ${matched.model.name} (${providerInfo})`,
            'ModelResolver'
          );
        } else {
          // 多个匹配，说明虚拟密钥配置了同名但不同供应商的模型
          const availableOptions = matchedModels.map(m => {
            if (m.provider) {
              return `${m.model.name} (${m.provider.name})`;
            } else {
              return `${m.model.name} (智能路由)`;
            }
          });

          memoryLogger.error(
            `模型名称 "${requestedModel}" 存在歧义，虚拟密钥中配置了多个同名模型。匹配到: ${availableOptions.join(', ')}`,
            'ModelResolver'
          );

          return {
            code: 400,
            body: {
              error: {
                message: `Ambiguous model name: "${requestedModel}". This virtual key has multiple models with the same name from different providers: ${availableOptions.join(', ')}. Please contact administrator to fix the virtual key configuration.`,
                type: 'invalid_request_error',
                param: null,
                code: 'ambiguous_model_configuration'
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

