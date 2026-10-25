import { memoryLogger } from "./logger.js";
import {
  countMessagesCooperatively,
  countResponsesInputCooperatively,
  countTextCooperatively,
} from "./token-counter.js";

/**
 * 上下文预算。
 *
 * 网关不改写历史、不生成摘要；只在用户轮次边界检查转发输入：
 * 超预算返回 400 context_length_exceeded，已验证客户端（pi / opencode）
 * 会自动压缩并重试。压缩请求按签名 + 宽限窗口豁免，任务执行中的
 * 续接请求一律放行、只告警。
 */

// 输出预留：生效预算不得吃满模型窗口，否则重试后输出可能撞上游真实上限。
const OUTPUT_RESERVE_TOKENS = 16_384;
// 分词估算误差安全余量（默认 5%）。
const ESTIMATE_SAFETY_MARGIN = 0.95;
// 拦截后宽限窗口：兜底签名失配，豁免客户端紧随其后的压缩/重试请求。
const GRACE_WINDOW_MS = 120_000;
const GRACE_REQUESTS = 2;
// 连续拦截循环告警（默认 3 次 / 10 分钟）。
const LOOP_ALERT_THRESHOLD = 3;
const LOOP_WINDOW_MS = 600_000;
// 轻量会话状态上限（不保存消息正文）。
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
  /** 仅 block 时存在：按协议返回错误 envelope（OpenAI 信封 / Anthropic 信封） */
  body?: Record<string, unknown>;
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
 * 请求分类：
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

/** Anthropic 顶层 system 字段（string 或 content blocks）→ 纯文本。 */
export function anthropicSystemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block: any) => (block && typeof block.text === "string" ? block.text : ""))
      .join("\n");
  }
  return "";
}

/**
 * Anthropic Messages 请求分类（与 Chat 分类同规则，按 Anthropic 块形态判定）：
 * - compaction：压缩签名命中顶层 system 或头部消息；
 * - boundary：最后一条 user 携带非 tool_result 内容（真实用户输入），且
 *   此前最近 assistant 的 tool_use 已全部被后续 tool_result 闭合；
 * - 其余（assistant 续跑、tool_result 回包、任务中插话）一律 continuation。
 */
export function classifyAnthropicRequest(
  messages: any[],
  systemText = "",
): RequestClassification {
  if (!Array.isArray(messages) || messages.length === 0) return "unknown";

  const head = messages.slice(0, 2).map(messageText).join("\n");
  if (
    COMPACTION_SIGNATURES.some((sig) => head.includes(sig) || systemText.includes(sig))
  ) {
    return "compaction";
  }

  const last = messages[messages.length - 1];
  if (last?.role !== "user") {
    return "continuation";
  }
  // tool_result-only 的 user 消息是工具回包，不是新用户输入。
  if (
    Array.isArray(last.content) &&
    last.content.length > 0 &&
    last.content.every((block: any) => block?.type === "tool_result")
  ) {
    return "continuation";
  }
  const answeredToolUseIds = new Set<string>();
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          answeredToolUseIds.add(block.tool_use_id);
        }
      }
      continue;
    }
    if (message?.role === "assistant") {
      const toolUses = Array.isArray(message.content)
        ? message.content.filter((block: any) => block?.type === "tool_use")
        : [];
      const hasOpenCalls = toolUses.some((block: any) => !answeredToolUseIds.has(block?.id));
      return hasOpenCalls ? "continuation" : "boundary";
    }
  }
  return "boundary";
}

// ── OpenAI Responses API（/v1/responses） ─────────────────────────────────

/** Responses instructions（协议定义为 string）→ 纯文本，宽容非字符串。 */
function responsesInstructionsText(instructions: unknown): string {
  return typeof instructions === "string" ? instructions : "";
}

/** Responses 消息项 content（string 或 content parts）→ 纯文本。 */
function responsesContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

/** input 中的 system/developer 项（含省略 type 的 EasyInputMessage）→ 纯文本。 */
function responsesSystemishText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .filter(
      (item: any) => item?.role === "system" || item?.role === "developer",
    )
    .map((item: any) => responsesContentText(item.content))
    .join("\n");
}

/** assistant 侧产出项：function_call / reasoning / *_call / assistant 消息。 */
function isResponsesAssistantItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "function_call" || type === "reasoning") return true;
  if (type.endsWith("_call") && !type.endsWith("_call_output")) return true;
  return item.role === "assistant";
}

/** 兼容内联 chat 形态：消息项上的 tool_calls（Responses 正规形态是 function_call 项）。 */
function hasOpenInlineToolCalls(item: any, answered: Set<string>): boolean {
  if (!Array.isArray(item?.tool_calls)) return false;
  return item.tool_calls.some((call: any) => !answered.has(call?.id));
}

/**
 * OpenAI Responses 请求分类（与 Chat 分类同规则，按 input 项形态判定）：
 * - unknown：previous_response_id / conversation 指向的上游会话状态网关
 *   不可见，无法核对转发输入的完整性，一律放行（预算上限只对客户端
 *   内联完整历史的请求生效）；
 * - compaction：压缩签名命中 instructions 或 system/developer 项；
 * - boundary：末尾是新用户输入（非 function_call_output 回包、非
 *   assistant 侧产出），且此前最近一段 assistant 项的 function_call
 *   已全部被后续 function_call_output 闭合；
 * - 其余（assistant 续跑、工具回包、任务中插话）一律 continuation。
 */
export function classifyResponsesRequest(
  input: unknown,
  instructionsText = "",
  hasUpstreamConversationState = false,
): RequestClassification {
  if (hasUpstreamConversationState) return "unknown";

  if (typeof input === "string") {
    return COMPACTION_SIGNATURES.some((sig) => instructionsText.includes(sig))
      ? "compaction"
      : "boundary";
  }
  if (!Array.isArray(input) || input.length === 0) return "unknown";

  const systemText = responsesSystemishText(input);
  if (
    COMPACTION_SIGNATURES.some(
      (sig) => instructionsText.includes(sig) || systemText.includes(sig),
    )
  ) {
    return "compaction";
  }

  const last = input[input.length - 1];
  // function_call_output 回包 / assistant 侧产出（含未回包的调用）都是轮次内续接。
  if (last?.type === "function_call_output") return "continuation";
  if (isResponsesAssistantItem(last)) return "continuation";
  if (last?.role === "tool") return "continuation"; // 内联 chat 形态的 tool 回包

  const answeredCallIds = new Set<string>();
  for (let i = input.length - 2; i >= 0; i--) {
    const item = input[i];
    if (
      item?.type === "function_call_output" &&
      typeof item.call_id === "string"
    ) {
      answeredCallIds.add(item.call_id);
      continue;
    }
    if (item?.role === "tool" && typeof item.tool_call_id === "string") {
      answeredCallIds.add(item.tool_call_id);
      continue;
    }
    if (isResponsesAssistantItem(item)) {
      // 并行 function_call / reasoning 连续成段：整段全部闭合才算边界。
      let hasOpenCalls =
        item.type === "function_call"
          ? !answeredCallIds.has(item.call_id)
          : false;
      if (hasOpenInlineToolCalls(item, answeredCallIds)) hasOpenCalls = true;
      for (let j = i - 1; j >= 0 && isResponsesAssistantItem(input[j]); j--) {
        const prev = input[j];
        if (
          prev?.type === "function_call" &&
          !answeredCallIds.has(prev.call_id)
        ) {
          hasOpenCalls = true;
        }
        if (hasOpenInlineToolCalls(prev, answeredCallIds)) hasOpenCalls = true;
      }
      return hasOpenCalls ? "continuation" : "boundary";
    }
    // 中间的 user / system / developer 项不改变轮次状态，继续回溯。
  }
  return "boundary";
}

/**
 * Responses 转发输入估算：input（string 或 item 数组，含 input/output 文本、
 * function_call 参数、function_call_output 回包、reasoning 文本）+
 * instructions + 工具定义，全部走共享 tiktoken 协作计数。
 */
export async function estimateResponsesInputTokens(
  input: unknown,
  instructions?: string,
  tools?: any[],
): Promise<number> {
  const inputTokens = await countResponsesInputCooperatively(input);
  const instructionTokens = instructions
    ? await countTextCooperatively(instructions)
    : 0;
  return inputTokens + instructionTokens + (await estimateToolsTokens(tools));
}

/**
 * 实际转发输入的保守估算：消息走共享 tiktoken 协作计数（含 system、
 * tool_calls 参数），工具定义按序列化 JSON 计数。中文等高密度文本的
 * chars/4 估算会低估数倍，预算判定必须走真实分词。
 */
export async function estimateForwardedInputTokens(
  messages: any[],
  tools?: any[],
  systemText?: string,
): Promise<number> {
  const messageTokens = await countMessagesCooperatively(
    Array.isArray(messages) ? messages : [],
  );
  const systemTokens = systemText ? await countTextCooperatively(systemText) : 0;
  return messageTokens + systemTokens + (await estimateToolsTokens(tools));
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

function buildExceededBody(
  effective: number,
  estimated: number,
  protocol: "openai" | "anthropic" | "responses" = "openai",
): Record<string, unknown> {
  if (protocol === "anthropic") {
    // Anthropic 原生措辞：客户端按 /prompt (?:is )?too long/i 识别后自动压缩重试。
    return {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `prompt is too long: ${estimated} tokens > ${effective} maximum`,
      },
    };
  }
  // OpenAI 溢出措辞（pi / opencode 均可识别）；Responses 的
  // param 指向 input 字段，其余与 Chat Completions 完全一致。
  return {
    error: {
      message: `This model's maximum context length is ${effective} tokens. However, your messages resulted in ${estimated} tokens. Please reduce the length of the messages.`,
      type: "invalid_request_error",
      param: protocol === "responses" ? "input" : "messages",
      code: "context_length_exceeded",
    },
  };
}

export interface CheckContextBudgetInput {
  virtualKeyId: string;
  /** Chat/Anthropic 协议的消息数组；responses 协议改传 input/instructions */
  messages?: any[];
  /** 随请求转发的工具定义，计入输入预算 */
  tools?: any[];
  /** Anthropic 顶层 system 字段（string 或 content blocks） */
  system?: unknown;
  /** Responses 协议的 input（string 或 item 数组） */
  input?: unknown;
  /** Responses 协议的 instructions（string） */
  instructions?: unknown;
  /** previous_response_id / conversation：上游持有历史，网关无法核对转发输入 */
  hasUpstreamConversationState?: boolean;
  /** 协议分支：分类规则与 block 错误 envelope；默认 openai */
  protocol?: "openai" | "anthropic" | "responses";
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
  if (input.protocol === "responses") {
    return estimateResponsesInputTokens(
      input.input,
      responsesInstructionsText(input.instructions),
      input.tools,
    );
  }
  const systemText =
    input.protocol === "anthropic" ? anthropicSystemText(input.system) : undefined;
  return estimateForwardedInputTokens(
    Array.isArray(input.messages) ? input.messages : [],
    input.tools,
    systemText,
  );
}

/**
 * 预算判定。必须在任何响应字节发出前调用；
 * block 时调用方直接返回 400 JSON（流式请求同样如此）。
 */
export async function checkContextBudget(
  input: CheckContextBudgetInput,
): Promise<BudgetVerdict> {
  const now = (input.now ?? Date.now)();
  const protocol = input.protocol ?? "openai";
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const classification =
    protocol === "anthropic"
      ? classifyAnthropicRequest(messages, anthropicSystemText(input.system))
      : protocol === "responses"
        ? classifyResponsesRequest(
            input.input,
            responsesInstructionsText(input.instructions),
            input.hasUpstreamConversationState === true,
          )
        : classifyChatRequest(messages);

  if (classification === "compaction") {
    return { action: "exempt", classification };
  }
  if (classification !== "boundary") {
    const estimated = await estimateInputTokens(input);
    const effective = effectiveBudgetTokens(input.budgetTokens, input.contextWindow);
    if (estimated > effective) {
      memoryLogger.warn(
        `上下文预算超限放行 | 虚拟密钥: ${input.virtualKeyId} | 分类: ${classification} | ` +
          `估算: ${estimated} > 预算: ${effective}（轮次内不拦截）`,
        "Proxy",
      );
    }
    return { action: "pass", classification };
  }

  const state = states.get(input.virtualKeyId);
  // 拦截后的宽限窗口：豁免签名失配的压缩请求与其重试。
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
    body: buildExceededBody(effective, estimated, protocol),
  };
}

/** 单测辅助：清空宽限/循环状态。 */
export function resetBudgetStates(): void {
  states.clear();
}
