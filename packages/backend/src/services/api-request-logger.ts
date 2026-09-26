import { nanoid } from "nanoid";
import { apiRequestDb } from "../db/index.js";
import { agentRunIdFromHeaders } from "../agent/run/loopback-token.js";
import type { VirtualKey } from "../types/index.js";
import type { TokenCalculationResult } from "../routes/proxy/token-calculator.js";
import { memoryLogger } from "./logger.js";

export interface ApiLogParams {
  virtualKey: VirtualKey;
  /** Undefined on early cache hits, where model/provider resolution never ran. */
  providerId: string | undefined;
  model: string;
  tokenCount: TokenCalculationResult; // { promptTokens, completionTokens, totalTokens }
  status: "success" | "error";
  responseTime: number;
  tffbMs?: number;
  errorMessage?: unknown;
  truncatedRequest?: string;
  truncatedResponse?: string;
  cacheHit?: 0 | 1;
  cachedTokens?: number;
  compressionStats?: { originalTokens: number; savedTokens: number };
  ip?: string;
  userAgent?: string;
  piiMaskedCount?: number;
  requestType?: string;
  streamResume?: { attempts: number; chars: number };
  /** agent run 关联显式值；缺省时从 request 头提取（需有效 loopback token） */
  agentRunId?: string;
  /** 原始请求，仅用于提取 loopback 可信的 run 关联头部 */
  request?: { headers: unknown };
}

function safeParseJson(text: string | undefined): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compactObject(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function extractRequestParamsJson(
  requestBody: string | undefined,
  piiMaskedCount?: number,
  streamResume?: { attempts: number; chars: number },
): string | undefined {
  const parsed = safeParseJson(requestBody);

  // Even if the request body can't be parsed (truncated/invalid),
  // we still need to persist pii_masked_count for dashboard stats
  if (!parsed || typeof parsed !== "object") {
    if (piiMaskedCount && piiMaskedCount > 0) {
      return JSON.stringify({ pii_masked_count: piiMaskedCount });
    }
    return undefined;
  }

  const params = compactObject({
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    max_tokens: parsed.max_tokens ?? parsed.max_completion_tokens,
    stream: parsed.stream,
    tool_choice: parsed.tool_choice,
    tools_count: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
    reasoning_effort: parsed.reasoning?.effort,
    user: parsed.user,
    pii_masked_count: piiMaskedCount,
    stream_resumed: streamResume ? true : undefined,
    stream_resume_attempts: streamResume?.attempts,
    stream_resume_chars: streamResume?.chars,
  });

  if (Object.keys(params).length === 0) return undefined;
  return JSON.stringify(params);
}

function extractResponseMetaJson(
  responseBody: string | undefined,
): string | undefined {
  const parsed = safeParseJson(responseBody);
  if (!parsed || typeof parsed !== "object") return undefined;

  const usage = parsed.usage ?? {};
  const finishReason = parsed.choices?.[0]?.finish_reason;
  const meta = compactObject({
    status: parsed.status,
    finish_reason: finishReason,
    input_tokens: usage.input_tokens ?? usage.prompt_tokens,
    output_tokens: usage.output_tokens ?? usage.completion_tokens,
    cached_tokens:
      usage.input_tokens_details?.cached_tokens ??
      usage.prompt_tokens_details?.cached_tokens,
  });

  if (Object.keys(meta).length === 0) return undefined;
  return JSON.stringify(meta);
}

function normalizeErrorMessage(errorMessage: unknown): string | undefined {
  if (errorMessage === undefined || errorMessage === null) {
    return undefined;
  }

  if (typeof errorMessage === "string") {
    return errorMessage;
  }

  try {
    return JSON.stringify(errorMessage);
  } catch {
    return String(errorMessage);
  }
}

export async function logApiRequestToDb(params: ApiLogParams): Promise<void> {
  const normalizedErrorMessage = normalizeErrorMessage(params.errorMessage);
  const agentRunId =
    params.agentRunId ?? agentRunIdFromHeaders(params.request?.headers);
  const requestParamsJson = extractRequestParamsJson(
    params.truncatedRequest,
    params.piiMaskedCount,
    params.streamResume,
  );
  const responseMetaJson = extractResponseMetaJson(params.truncatedResponse);

  // disable_logging：除已抑制的正文/参数外，ip、user_agent 和错误文本同属敏感元数据，
  // 写入侧直接置空（错误体可能回显 prompt 片段），读出侧另有字段白名单。
  const suppressSensitiveMetadata = !!params.virtualKey.disable_logging;
  const safeErrorMessage = suppressSensitiveMetadata
    ? undefined
    : normalizedErrorMessage;

  await apiRequestDb.create({
    id: nanoid(),
    virtual_key_id: params.virtualKey.id,
    provider_id: params.providerId,
    model: params.model || "unknown",
    prompt_tokens: params.tokenCount.promptTokens,
    completion_tokens: params.tokenCount.completionTokens,
    total_tokens: params.tokenCount.totalTokens,
    cached_tokens: params.cachedTokens,
    status: params.status,
    response_time: params.responseTime,
    tffb_ms: params.tffbMs,
    error_message: safeErrorMessage,
    request_body: params.truncatedRequest,
    response_body: params.truncatedResponse,
    request_params_json: requestParamsJson,
    response_meta_json: responseMetaJson,
    cache_hit: params.cacheHit ?? 0,
    request_type: params.requestType,
    compression_original_tokens: params.compressionStats?.originalTokens,
    compression_saved_tokens: params.compressionStats?.savedTokens,
    ip: suppressSensitiveMetadata ? undefined : params.ip,
    user_agent: suppressSensitiveMetadata ? undefined : params.userAgent,
    run_id: agentRunId,
  });
}

export function logApiRequestAsync(params: ApiLogParams): void {
  logApiRequestToDb(params).catch((e) => {
    memoryLogger.error(
      `API log write failed: ${e instanceof Error ? e.message : String(e)}`,
      "ApiRequestLogger",
    );
  });
}
