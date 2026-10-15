import { FastifyInstance, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { virtualKeyDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';
import { costMappingService } from '../services/cost-mapping.js';
import {
  extractAnthropicUsage,
  extractOpenAiUsage,
  extractStreamModel,
  extractUsageFromStreamChunks,
  type PlaygroundMetrics,
} from '../services/playground-metrics.js';
import type { VirtualKey } from '../types/index.js';

type PlaygroundProtocol = 'openai' | 'anthropic';

/** 运维监控按该 UA 识别 Playground 流量，勿改字符串。 */
const PLAYGROUND_USER_AGENT = 'llm-gateway-playground';
/** Playground 单次非流式调用（含 /v1/models）的时长上限。 */
const PLAYGROUND_CALL_TIMEOUT_MS = 120_000;
/** 流式 usage 累积上限：超出后停止累积（Anthropic 的输入 usage 在流头部已保留，
 *  超长 OpenAI 流可能丢尾部 usage chunk，此时 usage 展示为未知）。 */
const MAX_STREAM_USAGE_CHARS = 4 * 1024 * 1024;

function loopbackBase(): string {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function playgroundError(
  code: string,
  message: string,
): { error: { message: string; type: string; param: null; code: string } } {
  return {
    error: { message, type: 'invalid_request_error', param: null, code },
  };
}

function invalidBody(reply: FastifyReply, issues: z.ZodError['issues']) {
  return reply.code(400).send({
    error: {
      message: issues.map((i) => i.message).join('; '),
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_playground_request',
    },
  });
}

async function resolveVirtualKey(
  virtualKeyId: string,
  reply: FastifyReply,
): Promise<VirtualKey | null> {
  const vk = await virtualKeyDb.getById(virtualKeyId);
  if (!vk) {
    reply.code(404).send(playgroundError('virtual_key_not_found', '虚拟密钥不存在'));
    return null;
  }
  if (vk.enabled !== 1) {
    reply.code(403).send(playgroundError('virtual_key_disabled', '虚拟密钥已禁用'));
    return null;
  }
  return vk;
}

function loopbackHeaders(keyValue: string, protocol: PlaygroundProtocol) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${keyValue}`,
    'content-type': 'application/json',
    'user-agent': PLAYGROUND_USER_AGENT,
  };
  // 与 routes/anthropic/http-client.ts 的 ANTHROPIC_VERSION 一致
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return headers;
}

function buildMetrics(
  durationMs: number,
  ttftMs: number | null,
  usage: PlaygroundMetrics['usage'],
  model: string | null,
  requestId: string | null,
): PlaygroundMetrics {
  return { durationMs, ttftMs, usage, model, requestId };
}

/** 统一响应信封：前端 PlaygroundView 按此形状解析，不得偏离。 */
function wrapPlaygroundResult(args: {
  ok: boolean;
  status: number;
  protocol: PlaygroundProtocol;
  durationMs: number;
  ttftMs: number | null;
  cost: number | null;
  metrics: PlaygroundMetrics;
  body: unknown;
}) {
  const { ok, status, protocol, durationMs, ttftMs, cost, metrics, body } = args;
  return { ok, status, protocol, durationMs, ttftMs, cost, metrics, body };
}

function upstreamErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 把上游 SSE 字节流原样透传给客户端，结束后追加一帧
 * `event: playground` 携带耗时/成本指标。调用方需先完成 fetch 且
 * upstream.ok 为 true，再 hijack。
 */
async function relayPlaygroundStream(
  reply: FastifyReply,
  upstream: Response,
  protocol: PlaygroundProtocol,
  startedAt: number,
  abortController: AbortController,
): Promise<void> {
  // reply.raw 'close' + writableEnded 守卫隔离真实客户端断连；
  // request.raw 'close' 在请求体读取完成后也会触发（见 openai/proxy-handler.ts）
  const onClientClose = () => {
    if (!reply.raw.writableEnded) abortController.abort();
  };
  reply.raw.on('close', onClientClose);

  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });

  const chunks: string[] = [];
  let accumulatedChars = 0;
  const decoder = new TextDecoder();
  let ttftMs: number | null = null;

  try {
    // 字节原样透传，不做逐帧重编码；usage 从旁路累积的文本里解析
    const nodeStream = Readable.fromWeb(upstream.body as any);
    for await (const chunk of nodeStream) {
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      const bytes = chunk as Buffer;
      reply.raw.write(bytes);
      if (accumulatedChars < MAX_STREAM_USAGE_CHARS) {
        const text = decoder.decode(bytes, { stream: true });
        accumulatedChars += text.length;
        chunks.push(text);
      }
    }
    const flush = decoder.decode();
    if (flush) chunks.push(flush);
  } catch (streamError) {
    // 客户端断开：不再写任何字节，abort 已让上游读流抛错释放连接
    if (abortController.signal.aborted) return;
    // 非用户主动停止的上流中断：头已发出无法改状态码，只能记日志并以 playground 帧收尾。
    memoryLogger.warn(
      `Playground 流式上游中断 (${protocol}): ${streamError instanceof Error ? streamError.message : String(streamError)}`,
      'Proxy',
    );
    await appendPlaygroundFrame(reply, protocol, startedAt, ttftMs, chunks);
    if (!reply.raw.writableEnded) reply.raw.end();
    return;
  } finally {
    reply.raw.removeListener('close', onClientClose);
  }

  try {
    await appendPlaygroundFrame(reply, protocol, startedAt, ttftMs, chunks);
  } finally {
    // 无论如何都要收尾，否则 hijack 后的连接会挂到客户端超时
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

async function appendPlaygroundFrame(
  reply: FastifyReply,
  protocol: PlaygroundProtocol,
  startedAt: number,
  ttftMs: number | null,
  chunks: string[],
): Promise<void> {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  try {
    const durationMs = Date.now() - startedAt;
    const usage = extractUsageFromStreamChunks(chunks, protocol);
    const model = extractStreamModel(chunks, protocol);
    // 成本估算带 DB 读；它失败不能拖垮收尾（头已 hijack，抛错会留下不终止的连接）。
    let cost: number | null = null;
    if (usage) {
      try {
        cost = await costMappingService.estimateUsageCost(model, usage);
      } catch {
        cost = null;
      }
    }
    const metrics = buildMetrics(
      durationMs,
      ttftMs,
      usage,
      model,
      // 流式没有非流式响应里的 body.id，取网关转发头（无则 null）
      null,
    );
    reply.raw.write(
      `event: playground\ndata: ${JSON.stringify({ durationMs, ttftMs, cost, metrics })}\n\n`,
    );
  } catch (frameError) {
    // AGENTS.md 规定应用日志走 memoryLogger（运维可在 UI 日志页看到），不用 console。
    memoryLogger.warn(
      `Playground 计量帧写入失败: ${frameError instanceof Error ? frameError.message : String(frameError)}`,
      'Proxy',
    );
  }
}

/** 非流式 loopback 调用的公共收尾：解析 usage、算成本、按统一信封透传状态码。 */
async function sendNonStreamResult(
  reply: FastifyReply,
  upstream: Response,
  protocol: PlaygroundProtocol,
  startedAt: number,
  extractUsage: (json: any) => PlaygroundMetrics['usage'],
): Promise<unknown> {
  const durationMs = Date.now() - startedAt;
  const text = await upstream.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!upstream.ok) {
    // 透传上游错误信封与状态码，外面再包一层同形状信封
    const errorBody =
      body ??
      playgroundError(
        'playground_upstream_error',
        text || `upstream returned HTTP ${upstream.status}`,
      );
    return reply.code(upstream.status).send(
      wrapPlaygroundResult({
        ok: false,
        status: upstream.status,
        protocol,
        durationMs,
        ttftMs: null,
        cost: null,
        metrics: buildMetrics(durationMs, null, null, null, null),
        body: errorBody,
      }),
    );
  }

  if (body === null) {
    return reply.code(502).send(
      wrapPlaygroundResult({
        ok: false,
        status: 502,
        protocol,
        durationMs,
        ttftMs: null,
        cost: null,
        metrics: buildMetrics(durationMs, null, null, null, null),
        body: playgroundError(
          'playground_upstream_invalid_body',
          'upstream returned non-JSON body',
        ),
      }),
    );
  }

  const usage = extractUsage(body);
  const model = typeof body?.model === 'string' ? body.model : null;
  const requestId =
    upstream.headers.get('x-request-id') ??
    (typeof body?.id === 'string' ? body.id : null);
  const cost = usage
    ? await costMappingService.estimateUsageCost(model, usage)
    : null;
  return wrapPlaygroundResult({
    ok: true,
    status: upstream.status,
    protocol,
    durationMs,
    ttftMs: null,
    cost,
    metrics: buildMetrics(durationMs, null, usage, model, requestId),
    body,
  });
}

function sendUpstreamFetchFailure(
  reply: FastifyReply,
  protocol: PlaygroundProtocol,
  startedAt: number,
  e: unknown,
) {
  const durationMs = Date.now() - startedAt;
  return reply.code(502).send(
    wrapPlaygroundResult({
      ok: false,
      status: 502,
      protocol,
      durationMs,
      ttftMs: null,
      cost: null,
      metrics: buildMetrics(durationMs, null, null, null, null),
      body: playgroundError(
        'playground_upstream_failed',
        `gateway model call failed: ${upstreamErrorMessage(e)}`,
      ),
    }),
  );
}

const messageSchema = z.object({
  role: z.string().min(1),
  // 字符串或 content blocks 数组，透传不解释
  content: z.union([z.string(), z.array(z.unknown())]),
});

const chatRequestSchema = z.object({
  virtualKeyId: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  system: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional().default(false),
  // 原样浅合并进上游 body（覆盖顺序：extra 最后，可覆盖上面的字段）。
  // 信任边界：本路由整包 onRequest admin JWT，密钥/头部不来自 body，
  // 故 body 内字段可安全透传给 /v1。
  extra: z.record(z.string(), z.unknown()).optional(),
});

const messagesRequestSchema = z.object({
  virtualKeyId: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  system: z.string().optional(),
  max_tokens: z.number().int().positive().optional().default(1024),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
});

export async function playgroundRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/playground/chat', async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error.issues);
    const body = parsed.data;

    const vk = await resolveVirtualKey(body.virtualKeyId, reply);
    if (!vk) return reply;

    const startedAt = Date.now();
    // OpenAI 协议没有顶层 system，折算为首条 system message
    const upstreamBody: Record<string, unknown> = {
      model: body.model,
      messages: body.system
        ? [{ role: 'system', content: body.system }, ...body.messages]
        : body.messages,
      stream: body.stream,
    };
    if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;
    if (body.top_p !== undefined) upstreamBody.top_p = body.top_p;
    if (body.max_tokens !== undefined) upstreamBody.max_tokens = body.max_tokens;
    if (body.stop !== undefined) upstreamBody.stop = body.stop;
    if (body.extra) {
      // stream 以本路由自己的 body.stream 为准：让 extra 覆盖它会造成传输分支与
      // 上游实际形态不一致（非流式分支去解 SSE 文本 → 误报 502）。
      const { stream: _streamOverride, ...safeExtra } = body.extra;
      Object.assign(upstreamBody, safeExtra);
    }

    const abortController = new AbortController();
    let upstream: Response;
    try {
      upstream = await fetch(`${loopbackBase()}/v1/chat/completions`, {
        method: 'POST',
        headers: loopbackHeaders(vk.key_value, 'openai'),
        body: JSON.stringify(upstreamBody),
        signal: body.stream
          ? abortController.signal
          : AbortSignal.timeout(PLAYGROUND_CALL_TIMEOUT_MS),
      });
    } catch (e) {
      return sendUpstreamFetchFailure(reply, 'openai', startedAt, e);
    }

    if (body.stream && upstream.ok) {
      await relayPlaygroundStream(
        reply,
        upstream,
        'openai',
        startedAt,
        abortController,
      );
      return reply;
    }
    return sendNonStreamResult(
      reply,
      upstream,
      'openai',
      startedAt,
      extractOpenAiUsage,
    );
  });

  fastify.post('/playground/messages', async (request, reply) => {
    const parsed = messagesRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error.issues);
    const body = parsed.data;

    const vk = await resolveVirtualKey(body.virtualKeyId, reply);
    if (!vk) return reply;

    const startedAt = Date.now();
    const upstreamBody: Record<string, unknown> = {
      model: body.model,
      messages: body.messages,
      max_tokens: body.max_tokens,
      stream: body.stream,
    };
    if (body.system !== undefined) upstreamBody.system = body.system;
    if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;
    if (body.top_p !== undefined) upstreamBody.top_p = body.top_p;
    if (body.stop_sequences !== undefined)
      upstreamBody.stop_sequences = body.stop_sequences;

    const abortController = new AbortController();
    let upstream: Response;
    try {
      upstream = await fetch(`${loopbackBase()}/v1/messages`, {
        method: 'POST',
        headers: loopbackHeaders(vk.key_value, 'anthropic'),
        body: JSON.stringify(upstreamBody),
        signal: body.stream
          ? abortController.signal
          : AbortSignal.timeout(PLAYGROUND_CALL_TIMEOUT_MS),
      });
    } catch (e) {
      return sendUpstreamFetchFailure(reply, 'anthropic', startedAt, e);
    }

    if (body.stream && upstream.ok) {
      await relayPlaygroundStream(
        reply,
        upstream,
        'anthropic',
        startedAt,
        abortController,
      );
      return reply;
    }
    return sendNonStreamResult(
      reply,
      upstream,
      'anthropic',
      startedAt,
      extractAnthropicUsage,
    );
  });

  fastify.get('/playground/models', async (request, reply) => {
    const { virtualKeyId } = request.query as { virtualKeyId?: string };
    if (!virtualKeyId) {
      return reply
        .code(400)
        .send(playgroundError('missing_virtual_key_id', 'virtualKeyId is required'));
    }
    const vk = await virtualKeyDb.getById(virtualKeyId);
    if (!vk) {
      return { virtualKeyId, models: [], error: 'virtual key not found' };
    }
    // 与 chat/messages 的 403 同口径；本端点的失败契约是 200 + error 字段。
    if (vk.enabled !== 1) {
      return { virtualKeyId, models: [], error: 'virtual key disabled' };
    }

    try {
      const upstream = await fetch(`${loopbackBase()}/v1/models`, {
        headers: {
          authorization: `Bearer ${vk.key_value}`,
          'user-agent': PLAYGROUND_USER_AGENT,
        },
        signal: AbortSignal.timeout(PLAYGROUND_CALL_TIMEOUT_MS),
      });
      const json: any = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const message =
          json?.error?.message ?? `upstream returned HTTP ${upstream.status}`;
        return { virtualKeyId, models: [], error: String(message) };
      }
      // 上游 data 数组原样搬进 models
      const models = Array.isArray(json?.data) ? json.data : [];
      return { virtualKeyId, models };
    } catch (e) {
      return {
        virtualKeyId,
        models: [],
        error: upstreamErrorMessage(e),
      };
    }
  });
}
