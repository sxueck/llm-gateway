import {
  TIME_PRIORITY_ROUTING_MODE,
  timePriorityRoutingConfigSchema,
} from '@llm-gateway/shared';

export interface RoutingConfigValidationIssue {
  /** 已格式化的错误信息（可直接作为 400 响应的 error.message）。 */
  message: string;
  /** 指向无效字段的参数路径，如 config.strategy.time_rules.0.target_order。 */
  param: string;
}

/**
 * 校验写入 routing_configs 的配置体（当前仅 time_priority 模式有结构契约）。
 *
 * 判定条件：body.type 或 config.strategy.mode 任一为 time_priority 即按契约校验，
 * 两侧信号不一致也能拦住。其余模式沿用既有宽松行为，返回 null。
 */
export function validateRoutingConfigPayload(
  type: unknown,
  config: unknown
): RoutingConfigValidationIssue | null {
  const strategyMode = (config as any)?.strategy?.mode;
  if (type !== TIME_PRIORITY_ROUTING_MODE && strategyMode !== TIME_PRIORITY_ROUTING_MODE) {
    return null;
  }

  const parsed = timePriorityRoutingConfigSchema.safeParse(config);
  if (parsed.success) {
    return null;
  }

  const [issue] = parsed.error.issues;
  const path = issue?.path?.length ? `config.${issue.path.join('.')}` : 'config';
  return {
    message: `time_priority 路由配置无效: ${issue?.message ?? '配置结构错误'}`,
    param: path,
  };
}
