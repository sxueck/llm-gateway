import { memoryLogger } from "./logger.js";
import {
  countMessagesCooperatively,
  countTextCooperatively,
} from "./token-counter.js";

/**
 * 上下文预算（客户端压缩 2.0，docs/async-context-compaction-prd.md）。
 *
 * 网关不改写历史、不生成摘要；只在用户轮次边界检查转发输入：
 * 超预算返回 400 context_length_exceeded，已验证客户端（pi / opencode）
 * 会自动压缩并重试。压缩请求按签名 + 宽限窗口豁免，任务执行中的
 * 续接请求一律放行、只告警。
 */

// 输出预留：生效预算不得吃满模型窗口，否则重试后输出可能撞上游真实上限。
const OUTPUT_RESERVE_TOKENS = 16_384;
// 分词估算误差安全余量（PRD §4.2 默认 5%）。
const ESTIMATE_SAFETY_MARGIN = 0.95;
// 拦截后宽限窗口：兜底签名失配，豁免客户端紧随其后的压缩/重试请求（PRD §6.2）。
const GRACE_WINDOW_MS = 120_000;
const GRACE_REQUESTS = 2;
// 连续拦截循环告警（PRD §7：默认 3 次 / 10 分钟）。
const LOOP_ALERT_THRESHOLD = 3;
const LOOP_WINDOW_MS = 600_000;
// 轻量会话状态上限（PRD §8：不保存消息正文）。
const STATE_MAX_ENTRIES = 1024;
const STATE_TTL_MS = 1_800_000;

// 客户端压缩请求签名（实测 pi 1.2.0 / opencode 1.18.18，随客户端版本维护）。
const COMPACTION_SIGNATURES = [
  "context summarization assistant", // pi SUMMARIZATION_SYSTEM_PROMPT
  "context summarization agent", // opencode 压缩指令
];

export type RequestClassification =
  | "boundary"
  | "continuation"
  | "compaction"
  | "unknown";

export interface BudgetVerdict {
  action: "pass" | "exempt" | "block";
  classification: RequestClassification;
  /** 仅 block 时存在：OpenAI 错误 envelope（§5.1） */
  body?: { error: Record<string, string> };
  estimatedTokens?: number;
  effectiveBudget?: number;
}

function messageText(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block: any) => (block && typeof block.text === "string" ? block.text : ""))
      .join("\n");
  }
  return "";
}

/**
 * 请求分类（PRD §6）：
 * - compaction：命中客户端压缩签名；
 * - boundary：最后一条消息是新用户输入（非 tool 回包，且此前最近的
 *   assistant 消息没有未闭合的 tool_calls）——唯一会被拦截的类别；
 * - continuation / unknown：任务执行中的续接或无法识别，一律放行。
 */
export function classifyChatRequest(messages: any[]): RequestClassification {
  if (!Array.isArray(messages) || messages.length === 0) return "unknown";

  const head = messages.slice(0, 2).map(messageText).join("\n");
  const systemTexts = messages
    .filter((m) => m?.role === "system")
    .map(messageText)
    .join("\n");
  if (
    COMPACTION_SIGNATURES.some((sig) => head.includes(sig) || systemTexts.includes(sig))
  ) {
    return "compaction";
  }

  const last = messages[messages.length - 1];
  if (last?.role !== "user") {
    // role=tool 回传、assistant 自动续跑等都视为轮次内续接。
    return "continuation";
  }
  // 从末尾回溯到最近一条 assistant：其 tool_calls 已被后续 tool 回包全部
  // 闭合时，末尾的 user 是新轮次边界；存在未闭合调用说明用户在任务执行中
  // 插话，仍按续接处理（不拦截）。
  const answeredToolCallIds = new Set<string>();
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "tool") {
      if (typeof message.tool_call_id === "string") {
        answeredToolCallIds.add(message.tool_call_id);
      }
      continue;
    }
    if (message?.role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const hasOpenCalls = toolCalls.some(
        (call: any) => !answeredToolCallIds.has(call?.id),
      );
      return hasOpenCalls ? "continuation" : "boundary";
    }
    // 中间的 user / system 等消息不改变轮次状态，继续回溯。
  }
  return "boundary";
}

/**
 * 实际转发输入的保守估算：消息走共享 tiktoken 协作计数（含 system、
 * tool_calls 参数），工具定义按序列化 JSON 计数。中文等高密度文本的
 * chars/4 估算会低估数倍，预算判定必须走真实分词。
 */
export async function estimateForwardedInputTokens(
  messages: any[],
  tools?: any[],
): Promise<number> {
  const messageTokens = await countMessagesCooperatively(
    Array.isArray(messages) ? messages : [],
  );
  return messageTokens + (await estimateToolsTokens(tools));
}

async function estimateToolsTokens(tools?: any[]): Promise<number> {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return countTextCooperatively(JSON.stringify(tools));
}

/**
 * 生效预算 = min(配置档位, 模型上下文窗口 − 输出预留)。
 * 简化：仅对当前解析到的模型窗口取 min；负载均衡候选里存在更小窗口时，
 * 上游仍可能真实超窗（透传上游错误，由客户端继续收缩）。
 */
export function effectiveBudgetTokens(
  budgetTokens: number,
  contextWindow?: number,
): number {
  if (!contextWindow || contextWindow <= OUTPUT_RESERVE_TOKENS) {
    return budgetTokens;
  }
  return Math.max(1, Math.min(budgetTokens, contextWindow - OUTPUT_RESERVE_TOKENS));
}

interface BudgetState {
  lastRejectAt: number;
  rejectCount: number;
  graceRemaining: number;
  expiresAt: number;
}

const states = new Map<string, BudgetState>();

function pruneStates(now: number): void {
  if (states.size <= STATE_MAX_ENTRIES) {
    for (const [key, state] of states) {
      if (state.expiresAt <= now) states.delete(key);
    }
    return;
  }
  // 容量超限时先按过期时间淘汰，仍超限则淘汰最旧条目。
  for (const [key, state] of states) {
    if (state.expiresAt <= now) states.delete(key);
  }
  while (states.size > STATE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, state] of states) {
      if (state.lastRejectAt < oldestAt) {
        oldestAt = state.lastRejectAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    states.delete(oldestKey);
  }
}

function buildExceededBody(effective: number, estimated: number): {
  error: Record<string, string>;
} {
  return {
    error: {
      message: `This model's maximum context length is ${effective} tokens. However, your messages resulted in ${estimated} tokens. Please reduce the length of the messages.`,
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    },
  };
}

export interface CheckContextBudgetInput {
  virtualKeyId: string;
  messages: any[];
  /** 随请求转发的工具定义，计入输入预算 */
  tools?: any[];
  budgetTokens: number;
  contextWindow?: number;
  /** 已计数好的消息 tokens（如去重压缩统计），提供时跳过重算 */
  messagesTokens?: number;
  /** 单测注入时钟 */
  now?: () => number;
}

async function estimateInputTokens(input: CheckContextBudgetInput): Promise<number> {
  if (input.messagesTokens !== undefined) {
    return input.messagesTokens + (await estimateToolsTokens(input.tools));
  }
  return estimateForwardedInputTokens(input.messages, input.tools);
}

/**
 * 预算判定（PRD §4.1）。必须在任何响应字节发出前调用；
 * block 时调用方直接返回 400 JSON（流式请求同样如此，PRD §5.3）。
 */
export async function checkContextBudget(
  input: CheckContextBudgetInput,
): Promise<BudgetVerdict> {
  const now = (input.now ?? Date.now)();
  const classification = classifyChatRequest(input.messages);

  if (classification === "compaction") {
    return { action: "exempt", classification };
  }
  if (classification !== "boundary") {
    const estimated = await estimateInputTokens(input);
    const effective = effectiveBudgetTokens(input.budgetTokens, input.contextWindow);
    if (estimated > effective) {
      memoryLogger.warn(
        `上下文预算超限放行 | 虚拟密钥: ${input.virtualKeyId} | 分类: ${classification} | ` +
          `估算: ${estimated} > 预算: ${effective}（轮次内不拦截，PRD §4.3）`,
        "Proxy",
      );
    }
    return { action: "pass", classification };
  }

  const state = states.get(input.virtualKeyId);
  // 拦截后的宽限窗口：豁免签名失配的压缩请求与其重试（PRD §6.2 第二层）。
  if (
    state &&
    state.graceRemaining > 0 &&
    now < state.lastRejectAt + GRACE_WINDOW_MS
  ) {
    state.graceRemaining -= 1;
    return { action: "exempt", classification };
  }

  const estimated = await estimateInputTokens(input);
  const effective = effectiveBudgetTokens(input.budgetTokens, input.contextWindow);
  if (estimated <= effective * ESTIMATE_SAFETY_MARGIN) {
    return { action: "pass", classification, estimatedTokens: estimated, effectiveBudget: effective };
  }

  if (state) {
    const inLoopWindow = now < state.lastRejectAt + LOOP_WINDOW_MS;
    state.lastRejectAt = now;
    state.graceRemaining = GRACE_REQUESTS;
    state.expiresAt = now + STATE_TTL_MS;
    state.rejectCount = inLoopWindow ? state.rejectCount + 1 : 1;
    if (state.rejectCount >= LOOP_ALERT_THRESHOLD) {
      memoryLogger.warn(
        `上下文预算压缩循环告警 | 虚拟密钥: ${input.virtualKeyId} | ` +
          `${LOOP_WINDOW_MS / 60000} 分钟内连续拦截 ${state.rejectCount} 次，客户端压缩后仍超预算`,
        "Proxy",
      );
    }
  } else {
    pruneStates(now);
    states.set(input.virtualKeyId, {
      lastRejectAt: now,
      rejectCount: 1,
      graceRemaining: GRACE_REQUESTS,
      expiresAt: now + STATE_TTL_MS,
    });
  }

  return {
    action: "block",
    classification,
    estimatedTokens: estimated,
    effectiveBudget: effective,
    body: buildExceededBody(effective, estimated),
  };
}

/** 单测辅助：清空宽限/循环状态。 */
export function resetBudgetStates(): void {
  states.clear();
}
