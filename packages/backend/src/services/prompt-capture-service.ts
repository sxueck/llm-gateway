import { nanoid } from "nanoid";
import { jsonrepair } from "jsonrepair";
import type { FastifyRequest } from "fastify";
import { promptSampleDb } from "../db/index.js";
import type { VirtualKey } from "../types/index.js";
import { SignalBuilder } from "./expert-router/preprocess/index.js";
import { maskRequestBodyInPlace } from "./pii-protection-service.js";
import { memoryLogger } from "./logger.js";

type PromptCaptureProtocol = "openai" | "anthropic" | "gemini";

function copyRequestBody(body: unknown): any {
  return body === undefined ? {} : structuredClone(body);
}

// 匹配行首的对话角色标记（"User:" / "Assistant:" / "[1] User:" / "### Human" 等）。
// \b + [:：\-] 边界避免误伤普通文本。
const CONVERSATION_ROLE_RE =
  /^(?:\[\d+\]\s*|#+\s*|[-*]\s*|[-=]{3,}\s*)?(user|human|you|assistant|ai|model|system|developer)\b\s*[:：-]\s*/i;

const USER_ROLE_RE = /^(user|human|you)$/i;
const ASSISTANT_ROLE_RE = /^(assistant|ai|model)$/i;

// 仅捕获会话的首个 user prompt：agent/CLI 循环的后续轮次会携带完整对话历史
// 重新请求，若逐轮捕获会产生大量同源重复。存在 assistant/model 回合或
// 工具调用产物即视为非首轮。
function isFirstTurnRequest(body: any): boolean {
  if (!body || typeof body !== "object") return false;

  // Gemini native API：contents 中出现 model 回合或函数调用产物。
  if (Array.isArray(body.contents)) {
    return !body.contents.some(
      (content: any) =>
        content?.role === "model" ||
        (Array.isArray(content?.parts) &&
          content.parts.some(
            (part: any) =>
              part &&
              typeof part === "object" &&
              ("functionCall" in part || "functionResponse" in part),
          )),
    );
  }

  // Responses API：input 中出现 assistant 消息或工具/推理产物。
  if (body.input !== undefined || typeof body.text === "string") {
    const input = body.input ?? body.text;
    if (!Array.isArray(input)) return true;
    return !input.some((item: any) => {
      if (!item || typeof item !== "object") return false;
      if (item.role === "assistant") return true;
      return (
        item.type === "function_call" ||
        item.type === "function_call_output" ||
        item.type === "reasoning"
      );
    });
  }

  // Chat Completions / Anthropic：存在 assistant/tool 回合，或 user 消息内含 tool_result 块。
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return !messages.some((message: any) => {
    if (!message || typeof message !== "object") return false;
    if (message.role === "assistant" || message.role === "tool") return true;
    return (
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block: any) => block?.type === "tool_result")
    );
  });
}

// 客户端把多轮对话（含 assistant 回复）塞进单条 user message 时，剥离出
// 最后一段 user 段；无对话结构（单轮提问）则原样返回。
function stripConversationTurns(text: string): string {
  if (!text) return "";

  const lines = text.split(/\r?\n/);
  // 仅处理以角色标记开头的完整粘贴对话，避免将用户提问中引用的对话截断。
  const firstContentLine = lines.find((line) => line.trim());
  if (!firstContentLine || !CONVERSATION_ROLE_RE.test(firstContentLine))
    return text;

  type Segment = { role: string; text: string[] };
  const segments: Segment[] = [];
  let current: Segment | null = null;

  for (const line of lines) {
    const m = line.match(CONVERSATION_ROLE_RE);
    if (m) {
      const rest = line.slice(m[0].length).trim();
      current = { role: m[1].toLowerCase(), text: rest ? [rest] : [] };
      segments.push(current);
    } else if (current) {
      current.text.push(line);
    } else {
      // 角色标记之前的前导文本兜底为 user 段。
      current = { role: "user", text: [line] };
      segments.push(current);
    }
  }

  const roleSegments = segments.filter(
    (s) =>
      USER_ROLE_RE.test(s.role) ||
      ASSISTANT_ROLE_RE.test(s.role) ||
      /^(system|developer)$/i.test(s.role),
  );
  if (roleSegments.length === 0) return text;

  const hasAssistant = roleSegments.some((s) => ASSISTANT_ROLE_RE.test(s.role));
  const userSegments = roleSegments.filter((s) => USER_ROLE_RE.test(s.role));
  // 无 assistant 段或无 user 段 → 视为单轮提问，原样返回避免误伤。
  if (!hasAssistant || userSegments.length === 0) return text;

  const lastUser = userSegments[userSegments.length - 1];
  const result = lastUser.text.join("\n").trim();
  return result || text;
}

// Agent/orchestrator 循环请求会把工具执行回显打包进单条 user message，形如
// { "task": "...", "active_command": "...", "current_output_frame": "..." }。
// 这类 JSON 不是用户提问，且 active_command 常携带明文密钥，不应整段入库。
// 返回 null 表示不是 orchestrator 上下文；返回 '' 表示是但无可用意图（调用方应跳过捕获）；
// 非空字符串为提取出的意图文本。
function extractOrchestratorIntent(text: string): string | null {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(trimmed));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const task = obj.task;
  const isOrchestratorContext =
    typeof task === "string" &&
    (typeof obj.active_command === "string" ||
      typeof obj.current_output_frame === "string");
  if (!isOrchestratorContext) return null;

  // task 是固定模板（"The orchestrator executed this command…\n\nReason:\n<原因>\n\nExpected duration: …"），
  // 原因段才是意图核心，命令/输出帧一律丢弃。
  const reasonMatch = task.match(
    /Reason\s*:\s*([\s\S]*?)(?=\n\s*(?:Expected duration|$))/i,
  );
  const reason = reasonMatch?.[1]?.trim();
  if (reason) return reason;

  // 无 Reason 段时退回 task 本体，剥掉 orchestrator 模板前缀/尾部。
  return task
    .replace(
      /^The orchestrator executed this command for the reason given below\.\s*/i,
      "",
    )
    .replace(/\n\s*Expected duration:[\s\S]*$/, "")
    .trim();
}

export async function capturePromptSample(
  virtualKey: Pick<
    VirtualKey,
    "id" | "prompt_capture_enabled" | "pii_protection_enabled"
  >,
  request: Pick<FastifyRequest, "body">,
  protocol: PromptCaptureProtocol,
): Promise<void> {
  if (virtualKey.prompt_capture_enabled !== 1) return;
  if (!isFirstTurnRequest(request.body)) return;

  const body = copyRequestBody(request.body);
  if (virtualKey.pii_protection_enabled === 1) {
    maskRequestBodyInPlace(body, true);
  }

  const signal = await SignalBuilder.buildRoutingSignal(
    { body, protocol },
    { strip_tools: true, strip_files: true, strip_system_prompt: true },
  );
  // SignalBuilder 不感知单条 user message 内的对话轮次结构，二次剥离最后一段 user 段。
  const intentText = stripConversationTurns(signal.intentText).trim();
  if (!intentText) return;

  // orchestrator 上下文：仅保留提取出的意图；提取不到则跳过，避免把命令回显示入库。
  const orchestratorIntent = extractOrchestratorIntent(intentText);
  const finalIntent = orchestratorIntent === null ? intentText : orchestratorIntent;
  if (!finalIntent) return;

  await promptSampleDb.create({
    id: nanoid(),
    virtual_key_id: virtualKey.id,
    model: typeof body.model === "string" ? body.model : "unknown",
    protocol,
    intent_text: finalIntent,
    prompt_tokens: signal.stats?.promptTokens || 0,
    intent_truncated: signal.stats?.intentTruncated ? 1 : 0,
    created_at: Date.now(),
  });
}

export function capturePromptSampleAsync(
  virtualKey: Pick<
    VirtualKey,
    "id" | "prompt_capture_enabled" | "pii_protection_enabled"
  >,
  request: Pick<FastifyRequest, "body">,
  protocol: PromptCaptureProtocol,
): void {
  capturePromptSample(virtualKey, request, protocol).catch((error) => {
    memoryLogger.warn(
      `Prompt sample capture failed: ${error instanceof Error ? error.message : String(error)}`,
      "PromptCapture",
    );
  });
}
