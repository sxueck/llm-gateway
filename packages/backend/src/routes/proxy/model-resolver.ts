import { FastifyRequest } from 'fastify';
import { systemConfigDb } from '../../db/index.js';
import { hotConfigCache } from '../../services/hot-config-cache.js';
import { memoryLogger } from '../../services/logger.js';
import { reasoningEffortSuffixesCache } from '../../services/reasoning-effort-suffixes.js';
import { isChatCompletionsPath } from '../../utils/path-detector.js';
import { resolveProviderFromModel } from './routing.js';

export interface ModelResolutionResult {
  provider: any;
  providerId: string;
  circuitBreakerKey?: string;
  currentModel?: any;
  excludeTargetKeys?: Set<string>;
  canRetry?: boolean; // 是否支持重试（仅智能路由模式）
  modelId?: string; // 用于重试时重新解析
  forcedReasoningEffort?: string; // 由模型名后缀解析得到的强制 reasoning_effort
}

/**
 * 纯函数：按最后一个 `-` 分割模型名，检查后缀是否在白名单中。
 * 仅当前缀非空且后缀精确匹配白名单时返回解析结果。
 */
export function parseModelSuffix(
  requestedModel: string,
  allowedSuffixes: string[]
): { baseModel: string; reasoningEffort: string } | null {
  if (!requestedModel || !allowedSuffixes || allowedSuffixes.length === 0) {
    return null;
  }

  const lastDashIndex = requestedModel.lastIndexOf('-');
  if (lastDashIndex <= 0) return null;

  const suffix = requestedModel.slice(lastDashIndex + 1);
  const baseModel = requestedModel.slice(0, lastDashIndex);

  if (!baseModel || !suffix) return null;
  if (!allowedSuffixes.includes(suffix)) return null;

  return { baseModel, reasoningEffort: suffix };
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

/**
 * 在多模型虚拟密钥中按模型名收集匹配的模型候选。
 * 仅返回有有效供应商或启用了智能路由的模型。
 */
async function collectModelMatches(
  parsedModelIds: string[],
  modelName: string
): Promise<Array<{ modelId: string; model: any; provider?: any }>> {
  const matches: Array<{ modelId: string; model: any; provider?: any }> = [];

  for (const modelId of parsedModelIds) {
    const model = await hotConfigCache.getModelById(modelId);
    if (!model) continue;

    const modelNameMatch =
      model.model_identifier === modelName || model.name === modelName;
    if (!modelNameMatch) continue;

    if (model.is_virtual === 1 && (model.routing_config_id || model.expert_routing_id)) {
      matches.push({ modelId, model });
    } else if (model.provider_id) {
      const provider = await hotConfigCache.getProviderById(model.provider_id);
      if (provider) {
        matches.push({ modelId, model, provider });
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

  return matches;
}

export async function resolveModelAndProvider(
  virtualKey: any,
  request: FastifyRequest,
  virtualKeyValue: string
): Promise<ModelResolutionResult | ModelResolutionError> {
  let provider;
  let currentModel;
  let providerId: string | undefined;

  // 监控专用密钥：健康检查请求只在监控虚拟密钥绑定的模型中解析目标模型
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

        // 只在监控虚拟密钥绑定的模型中查找目标模型，避免被其他同名模型干扰
        const candidateModelIds: string[] = [];
        if (virtualKey.model_id) {
          candidateModelIds.push(virtualKey.model_id);
        }
        if (virtualKey.model_ids) {
          try {
            const parsed = JSON.parse(virtualKey.model_ids);
            if (Array.isArray(parsed)) {
              for (const id of parsed) {
                if (typeof id === 'string') {
                  candidateModelIds.push(id);
                }
              }
            }
          } catch (e) {
            memoryLogger.error(`Failed to parse monitoring virtual key model_ids: ${e}`, 'ModelResolver');
          }
        }

        const uniqueCandidateIds = [...new Set(candidateModelIds)];
        if (uniqueCandidateIds.length === 0) {
          memoryLogger.error(
            `Monitoring virtual key ${virtualKey.id} has no bound models for health check`,
            'ModelResolver'
          );
          return {
            code: 500,
            body: {
              error: {
                message: 'Monitoring virtual key has no bound models',
                type: 'internal_error',
                param: null,
                code: 'monitoring_key_no_models'
              }
            }
          };
        }

        const candidateModels: Array<{ id: string; model: any }> = [];
        for (const id of uniqueCandidateIds) {
          try {
            const m = await hotConfigCache.getModelById(id);
            if (m && m.enabled) {
              candidateModels.push({ id, model: m });
            }
          } catch (e) {
            memoryLogger.warn(
              `Failed to load model ${id} for monitoring virtual key ${virtualKey.id}: ${e}`,
              'ModelResolver'
            );
          }
        }

        const matchedModels = candidateModels.filter(({ model }) =>
          model?.model_identifier === requestedModel || model?.name === requestedModel
        );

        if (matchedModels.length === 0) {
          memoryLogger.error(
            `Health check model not found in monitoring virtual key models: ${requestedModel}`,
            'ModelResolver'
          );
          return {
            code: 404,
            body: {
              error: {
                message: `Model not found for health check in monitoring virtual key: ${requestedModel}`,
                type: 'invalid_request_error',
                param: null,
                code: 'model_not_found'
              }
            }
          };
        }

        if (matchedModels.length > 1) {
          const options = matchedModels.map(({ model }) => `${model.name} (${model.provider_id || 'no-provider'})`);
          memoryLogger.error(
            `Health check model name "${requestedModel}" is ambiguous within monitoring virtual key. ` +
              `Matched: ${options.join(', ')}`,
            'ModelResolver'
          );
          return {
            code: 400,
            body: {
              error: {
                message:
                  `Ambiguous model name for health check: "${requestedModel}". ` +
                  `Monitoring virtual key has multiple models with the same name: ${options.join(', ')}.`,
                type: 'invalid_request_error',
                param: null,
                code: 'ambiguous_health_check_model'
              }
            }
          };
        }

        const { model, id: selectedModelId } = matchedModels[0];

        currentModel = model;
        try {
          const result = await resolveProviderFromModel(model, request as any, virtualKey.id);
          provider = result.provider;
          providerId = result.providerId;

          if (result.resolvedModel) {
            currentModel = result.resolvedModel;
          }

          const canRetry = !!(model.is_virtual && model.routing_config_id && result.canRetry);

          return {
            provider,
            providerId: providerId!,
            circuitBreakerKey: result.circuitBreakerKey || providerId!,
            currentModel,
            excludeTargetKeys: result.excludeTargetKeys,
            canRetry,
            modelId: selectedModelId
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
    const model = await hotConfigCache.getModelById(virtualKey.model_id);
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
      if (result.resolvedModel) {
        currentModel = result.resolvedModel;
      }

      const canRetry = !!(model.is_virtual && model.routing_config_id && result.canRetry);

      return {
        provider,
        providerId: providerId!,
        circuitBreakerKey: result.circuitBreakerKey || providerId!,
        currentModel,
        excludeTargetKeys: result.excludeTargetKeys,
        canRetry,
        modelId: virtualKey.model_id
      };
    } catch (routingError: any) {
      memoryLogger.error(`Smart routing failed: ${routingError.message}`, 'Proxy');
      return {
        code: routingError.statusCode || 500,
        body: {
          error: {
            message: routingError.message || 'Smart routing failed',
            type: 'internal_error',
            param: null,
            code: routingError.code || 'smart_routing_error'
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
      let selectedModel: any | undefined;
      let forcedReasoningEffort: string | undefined;

      if (requestedModel) {
        // 收集所有匹配的模型
        const matchedModels = await collectModelMatches(parsedModelIds, requestedModel);

        if (matchedModels.length === 0) {
          // FR-1: 仅当入口协议为 OpenAI 且请求目标为 Chat Completions 时，才尝试模型名后缀解析
          const isOpenAiChatCompletions =
            (request as any).protocol === 'openai' &&
            isChatCompletionsPath((request as any).url || '');

          const parsed = isOpenAiChatCompletions
            ? parseModelSuffix(requestedModel, reasoningEffortSuffixesCache.getSuffixes())
            : null;

          if (parsed) {
            const baseMatched = await collectModelMatches(parsedModelIds, parsed.baseModel);

            if (baseMatched.length === 1) {
              forcedReasoningEffort = parsed.reasoningEffort;
              const matched = baseMatched[0];
              targetModelId = matched.modelId;
              selectedModel = matched.model;
              // 保留实际生效的模型和 effort，确保上游、缓存与重试使用同一请求语义。
              (request.body as any).model = parsed.baseModel;
              (request.body as any).reasoning_effort = parsed.reasoningEffort;
              const providerInfo = matched.provider ? matched.provider.name : '智能路由';
              memoryLogger.debug(
                `模型后缀解析: ${requestedModel} -> 基础模型 ${matched.model.name} (${providerInfo}) + reasoning_effort=${parsed.reasoningEffort}`,
                'ModelResolver'
              );
            } else if (baseMatched.length > 1) {
              // 基础模型名仍有多个候选，维持既有歧义行为，不通过后缀规避
              const availableOptions = baseMatched.map(m => {
                if (m.provider) {
                  return `${m.model.name} (${m.provider.name})`;
                } else {
                  return `${m.model.name} (智能路由)`;
                }
              });

              memoryLogger.error(
                `基础模型名称 "${parsed.baseModel}" 存在歧义，虚拟密钥中配置了多个同名模型。匹配到: ${availableOptions.join(', ')}`,
                'ModelResolver'
              );

              return {
                code: 400,
                body: {
                  error: {
                    message: `Ambiguous model name: "${parsed.baseModel}". This virtual key has multiple models with the same name from different providers: ${availableOptions.join(', ')}. Please contact administrator to fix the virtual key configuration.`,
                    type: 'invalid_request_error',
                    param: null,
                    code: 'ambiguous_model_configuration'
                  }
                }
              };
            }
            // baseMatched.length === 0 → 后缀解析未找到基础模型，继续返回 model_not_found
          }

          if (!selectedModel) {
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
          }
        } else if (matchedModels.length === 1) {
          // 只有一个匹配，使用它
          const matched = matchedModels[0];
          targetModelId = matched.modelId;
          selectedModel = matched.model;
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

      if (!selectedModel) {
        const missingModels: string[] = [];
        for (const candidateId of parsedModelIds) {
          const candidateModel = await hotConfigCache.getModelById(candidateId);
          if (!candidateModel) {
            memoryLogger.warn(
              `虚拟密钥 ${virtualKeyValue} 引用了不存在的模型: ${candidateId}，已跳过`,
              'ModelResolver'
            );
            missingModels.push(candidateId);
            continue;
          }

          targetModelId = candidateId;
          selectedModel = candidateModel;
          break;
        }

        // 如果所有模型都不存在，记录错误
        if (missingModels.length === parsedModelIds.length) {
          memoryLogger.error(
            `虚拟密钥 ${virtualKeyValue} 的所有模型配置都不存在: ${parsedModelIds.join(', ')}`,
            'ModelResolver'
          );
        } else if (missingModels.length > 0) {
          memoryLogger.info(
            `虚拟密钥 ${virtualKeyValue} 有 ${missingModels.length}/${parsedModelIds.length} 个模型不存在，但仍有可用模型`,
            'ModelResolver'
          );
        }
      }

      if (!targetModelId || !selectedModel) {
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

      const model = selectedModel;

      currentModel = model;

      try {
        const result = await resolveProviderFromModel(model, request as any, virtualKey.id);
        provider = result.provider;
        providerId = result.providerId;
        if (result.resolvedModel) {
          currentModel = result.resolvedModel;
        }

        const canRetry = !!(model.is_virtual && model.routing_config_id && result.canRetry);

        return {
          provider,
          providerId: providerId!,
          circuitBreakerKey: result.circuitBreakerKey || providerId!,
          currentModel,
          excludeTargetKeys: result.excludeTargetKeys,
          canRetry,
          modelId: targetModelId,
          forcedReasoningEffort,
        };
      } catch (routingError: any) {
        memoryLogger.error(`Smart routing failed: ${routingError.message}`, 'Proxy');
        return {
          code: routingError.statusCode || 500,
          body: {
            error: {
              message: routingError.message || 'Smart routing failed',
              type: 'internal_error',
              param: null,
              code: routingError.code || 'smart_routing_error'
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
    provider = await hotConfigCache.getProviderById(virtualKey.provider_id);
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
    circuitBreakerKey: providerId!,
    currentModel
  };
}

export async function retrySmartRouting(
  virtualKey: any,
  request: FastifyRequest,
  modelId: string,
  excludeTargetKeys: Set<string>
): Promise<ModelResolutionResult | ModelResolutionError> {
  const model = await hotConfigCache.getModelById(modelId);
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
    // 直接基于已排除 target 重新选择，避免重复命中已失败的真实模型。
    const retryResult = await resolveSmartRoutingWithExclude(
      model,
      request as any,
      virtualKey.id,
      excludeTargetKeys
    );

    if (!retryResult) {
      throw new Error('No more available targets for retry');
    }

    let currentModel = model;
    if (retryResult.resolvedModel) {
      currentModel = retryResult.resolvedModel;
    }

    const canRetry = retryResult.canRetry === true;

    return {
      provider: retryResult.provider,
      providerId: retryResult.providerId!,
      circuitBreakerKey: retryResult.circuitBreakerKey || retryResult.providerId!,
      currentModel,
      excludeTargetKeys: retryResult.excludeTargetKeys,
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
  excludeTargetKeys?: Set<string>
): Promise<any> {
  const { resolveSmartRouting } = await import('./routing.js');
  return await resolveSmartRouting(model, request, virtualKeyId, excludeTargetKeys);
}
