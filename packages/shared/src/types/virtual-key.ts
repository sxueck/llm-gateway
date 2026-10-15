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
