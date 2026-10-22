import { z } from "zod";
import { CONTEXT_BUDGET_TIERS } from "../constants/context-budget.js";

// 上下文预算档位（客户端压缩 2.0）：null=关闭；只接受固定档位。
export const contextBudgetTokensSchema = z
  .number()
  .int()
  .nullable()
  .refine(
    (value) => value === null || (CONTEXT_BUDGET_TIERS as readonly number[]).includes(value),
    { message: "上下文预算档位必须是 200000/400000/600000/800000 或 null" },
  );

// 路由策略契约：admin 写入校验与 proxy 运行时解析共用这一份取值集合，避免两侧各自漂移。
export const PER_REQUEST_ROUTING_STRATEGIES = ["default", "price", "throughput", "latency"] as const;
export type PerRequestRoutingStrategy = (typeof PER_REQUEST_ROUTING_STRATEGIES)[number];

// 'single' 是 virtual_keys.routing_strategy 的历史别名（等价于 'default'），仍可写入以兼容存量行。
export const LEGACY_SINGLE_ROUTING_STRATEGY = "single";
export const VIRTUAL_KEY_ROUTING_STRATEGIES = [
  LEGACY_SINGLE_ROUTING_STRATEGY,
  ...PER_REQUEST_ROUTING_STRATEGIES,
] as const;
export type VirtualKeyRoutingStrategy = (typeof VIRTUAL_KEY_ROUTING_STRATEGIES)[number];

export function isVirtualKeyRoutingStrategyInput(raw: unknown): raw is VirtualKeyRoutingStrategy {
  if (typeof raw !== "string") return false;
  return (VIRTUAL_KEY_ROUTING_STRATEGIES as readonly string[]).includes(raw.trim().toLowerCase());
}

export const virtualKeyRoutingStrategySchema = z.string().refine(isVirtualKeyRoutingStrategyInput, {
  message: `路由策略必须是 ${VIRTUAL_KEY_ROUTING_STRATEGIES.join("/")} 之一`,
});
