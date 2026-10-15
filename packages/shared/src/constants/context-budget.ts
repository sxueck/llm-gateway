// 上下文预算档位（客户端压缩 2.0，docs/async-context-compaction-prd.md）：
// 虚拟密钥可配置的边界预算 tokens；null 表示关闭。
export const CONTEXT_BUDGET_TIERS = [200_000, 400_000, 600_000, 800_000] as const;
