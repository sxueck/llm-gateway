/**
 * Playground 指标纯函数集：无 DB / 无 fastify 依赖，便于单测。
 *
 * 这些函数是 Playground 代理（routes/playground.ts）指标展示的唯一来源。
 * 为什么不能只依赖流式 chunk：
 *  1. 上游不保证在流里回传 usage —— OpenAI 需要 stream_options.include_usage，
 *     部分上游通道会直接剥掉 usage 字段，此时 usage 只能是 null（展示"未知"）；
 *  2. 客户端断流 / 上游中断时 chunk 累积不完整，指标只能"尽力而为"。
 * 因此这里只做纯解析，缺失时返回 null，由前端决定降级展示。
 */

export interface PlaygroundUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export interface PlaygroundMetrics {
  durationMs: number;
  ttftMs: number | null;
  usage: PlaygroundUsage | null;
  model: string | null;
  requestId: string | null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function sumTokens(
  usage: Pick<PlaygroundUsage, "promptTokens" | "completionTokens">,
): number {
  return usage.promptTokens + usage.completionTokens;
}

/**
 * OpenAI 口径：兼容 chat completions（prompt_tokens/prompt_tokens_details）
 * 与 responses（input_tokens/input_tokens_details）两种写法。
 * prompt_tokens 本身已包含 cached_tokens，直接透传，total 优先取 total_tokens。
 */
export function extractOpenAiUsage(json: any): PlaygroundUsage | null {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = count(
    usage.prompt_tokens ?? usage.input_tokens,
  );
  const completionTokens = count(
    usage.completion_tokens ?? usage.output_tokens,
  );
  const cachedTokens = count(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens,
  );
  if (promptTokens === 0 && completionTokens === 0 && cachedTokens === 0) {
    return null;
  }
  const result: PlaygroundUsage = {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: count(usage.total_tokens),
  };
  if (result.totalTokens === 0) result.totalTokens = sumTokens(result);
  return result;
}

/**
 * Anthropic 口径：input_tokens 不含 cache 部分，计费输入 = 三者之和
 * （与 routes/anthropic/http-client.ts 的 promptTokens 汇总一致）。
 * cachedTokens 只计 cache_read：estimateUsageCost 按 cache_read 单价计价
 * cachedTokens，cache_creation 是 1.25x 写入溢价，混入会低估成本。
 */
export function extractAnthropicUsage(json: any): PlaygroundUsage | null {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheCreation = count(usage.cache_creation_input_tokens);
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheRead === 0 &&
    cacheCreation === 0
  ) {
    return null;
  }
  const result: PlaygroundUsage = {
    promptTokens: inputTokens + cacheRead + cacheCreation,
    completionTokens: outputTokens,
    cachedTokens: cacheRead,
    totalTokens: 0,
  };
  result.totalTokens = sumTokens(result);
  return result;
}

export interface PlaygroundSseFrame {
  event: string | null;
  data: string | null;
}

/**
 * 解析 SSE 文本为完整帧列表。
 * - 兼容 \r\n / \n 两种行结束符，帧以空行分隔；
 * - 以 ':' 开头的注释/心跳行忽略；
 * - 末尾未出现空行终止的残帧丢弃（调用方传入的是累积完整文本；
 *   残帧 JSON 必然不完整，提前解析只会得到噪声）。
 */
export function parseSseChunkBuffer(buf: string): PlaygroundSseFrame[] {
  const frames: PlaygroundSseFrame[] = [];
  if (!buf) return frames;

  const blocks = buf.replace(/\r\n/g, "\n").split("\n\n");
  for (let i = 0; i < blocks.length - 1; i++) {
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of blocks[i].split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice(6).replace(/^ /, "");
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (event === null && dataLines.length === 0) continue;
    frames.push({
      event,
      data: dataLines.length > 0 ? dataLines.join("\n") : null,
    });
  }
  return frames;
}

function parseFrameData(chunks: string[]): any[] {
  const events: any[] = [];
  for (const frame of parseSseChunkBuffer(chunks.join(""))) {
    if (!frame.data) continue;
    try {
      events.push(JSON.parse(frame.data));
    } catch {
      // 上游偶发非 JSON 帧（如探活文本），跳过
    }
  }
  return events;
}

/** 从流式 chunk 文本取最终 usage；缺失时返回 null（见文件头注释）。 */
export function extractUsageFromStreamChunks(
  chunks: string[],
  protocol: "openai" | "anthropic",
): PlaygroundUsage | null {
  const events = parseFrameData(chunks);

  if (protocol === "openai") {
    // stream_options.include_usage 时只有最后一个 chunk 带 usage，取最后命中
    for (let i = events.length - 1; i >= 0; i--) {
      const usage = extractOpenAiUsage(events[i]);
      if (usage) return usage;
    }
    return null;
  }

  // Anthropic：输入侧在 message_start（message.usage，含 cache 字段），
  // 输出侧在最后一个 message_delta.usage.output_tokens。
  let promptSide: PlaygroundUsage | null = null;
  let outputTokens: number | null = null;
  for (const event of events) {
    if (event?.type === "message_start") {
      promptSide = extractAnthropicUsage({
        usage: event.message?.usage ?? event.usage,
      });
    } else if (
      event?.type === "message_delta" &&
      event.usage &&
      typeof event.usage.output_tokens === "number"
    ) {
      outputTokens = event.usage.output_tokens;
    }
  }
  if (!promptSide && outputTokens === null) return null;

  const promptTokens = promptSide?.promptTokens ?? 0;
  const cachedTokens = promptSide?.cachedTokens ?? 0;
  const completionTokens = outputTokens ?? promptSide?.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

/** 从流式 chunk 文本取模型名（OpenAI 任意 chunk.model / Anthropic message_start）。 */
export function extractStreamModel(
  chunks: string[],
  protocol: "openai" | "anthropic",
): string | null {
  for (const event of parseFrameData(chunks)) {
    if (protocol === "openai") {
      if (typeof event?.model === "string") return event.model;
    } else if (
      event?.type === "message_start" &&
      typeof event.message?.model === "string"
    ) {
      return event.message.model;
    }
  }
  return null;
}
