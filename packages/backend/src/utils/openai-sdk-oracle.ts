/**
 * openai@7.25.0 SDK oracle harness（仅测试基础设施）。
 *
 * 用 SDK 自带的公共/内部接口原样消费网关下游 SSE，绝不模拟其行为：
 *  1. `Stream.fromSSEResponse` —— SDK 的 SSE 解析器（处理 `event:` 前缀与
 *     `data: [DONE]` 哨兵）；
 *  2. `ResponseStream.fromReadableStream` / `ChatCompletionStream.fromReadableStream`
 *     —— SDK 真实的响应/对话聚合器（`accumulateResponseWithContext` /
 *     `_accumulateChatCompletion`），对事件序列做严格校验（缺输出项、
 *     身份漂移、重复项等都会抛错）；
 *  3. `finalResponse()` / `finalChatCompletion()` —— SDK 暴露给调用方的终态。
 *
 * 两段之间用 SDK 的 NDJSON 序列化契约（`toReadableStream` 的镜像：
 * 每行一个 JSON 对象）桥接。
 */
import { Stream } from 'openai/streaming';
import { ResponseStream } from 'openai/lib/responses/ResponseStream.js';
import { ChatCompletionStream } from 'openai/lib/ChatCompletionStream.js';

/** 心跳注释帧（': ' 开头）不属于任何事件，SSE 规范要求解析器忽略。 */
export function sseDataFrames(frames: string[]): string[] {
  return frames.filter((frame) => frame.startsWith('data:'));
}

/** 把下游 SSE 帧送进 SDK 的 SSE 解析器，产出原始事件对象序列。 */
async function* parseSseWithSdk(frames: string[]): AsyncIterable<any> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  // 客户端视角的 text/event-stream 响应；SDK 负责一切解析。
  const sseResponse = new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
  const parsed = Stream.fromSSEResponse(sseResponse, new AbortController());
  for await (const event of parsed) yield event;
}

/** SDK 序列化契约（NDJSON，每行一个 JSON 对象）。 */
function eventsToNdjson(events: AsyncIterable<any>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const event of events) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      }
      controller.close();
    },
  });
}

export interface SdkResponsesOutcome {
  /** `finalResponse()` 的结果；流非法时为 SDK 抛出的错误。 */
  response: any | null;
  error: { name: string; message: string } | null;
  /** SDK SSE 解析器看到的全部事件 type（按序）。 */
  eventTypes: string[];
  /** 是否收到 `data: [DONE]` 哨兵。 */
  sawDoneSentinel: boolean;
}

/** 用真实 ResponseStream 聚合器消费完整下游 resume SSE。 */
export async function consumeResponsesSseWithSdk(frames: string[]): Promise<SdkResponsesOutcome> {
  const eventTypes: string[] = [];
  let sawDoneSentinel = false;
  let response: any = null;
  let error: { name: string; message: string } | null = null;

  const events = (async function* () {
    for await (const event of parseSseWithSdk(frames)) {
      eventTypes.push(String(event?.type ?? ''));
      yield event;
    }
  })();
  // [DONE] 哨兵只会出现在帧文本里；SDK 解析器读到即静默收尾。
  sawDoneSentinel = frames.some((frame) => frame.trim() === 'data: [DONE]');

  const runner = ResponseStream.fromReadableStream(eventsToNdjson(events));
  try {
    response = await runner.finalResponse();
  } catch (err: any) {
    error = { name: String(err?.name ?? err?.constructor?.name ?? 'Error'), message: String(err?.message ?? err) };
  }
  return { response, error, eventTypes, sawDoneSentinel };
}

export interface SdkChatOutcome {
  /** `finalChatCompletion()` 的结果；流非法时为 SDK 抛出的错误。 */
  completion: any | null;
  message: any | null;
  error: { name: string; message: string } | null;
  eventTypes: string[];
  sawDoneSentinel: boolean;
  /** 聚合器随每个 chunk 广播的最新快照（终态被拒后仍可核对部分文本）。 */
  lastSnapshot: any | null;
}

/** 用真实 ChatCompletionStream 聚合器消费完整下游 resume SSE。 */
export async function consumeChatSseWithSdk(frames: string[]): Promise<SdkChatOutcome> {
  const eventTypes: string[] = [];
  const sawDoneSentinel = frames.some((frame) => frame.trim() === 'data: [DONE]');
  let completion: any = null;
  let message: any = null;
  let error: { name: string; message: string } | null = null;
  let lastSnapshot: any = null;

  const events = (async function* () {
    let index = 0;
    for await (const event of parseSseWithSdk(frames)) {
      eventTypes.push(`chunk:${index++}:${String(event?.choices?.[0]?.finish_reason ?? '')}`);
      yield event;
    }
  })();

  const runner = ChatCompletionStream.fromReadableStream(eventsToNdjson(events));
  // 'chunk' 是 runner 的公共事件；第二个参数是聚合中的完成快照。
  runner.on('chunk', (_chunk: any, snapshot: any) => {
    lastSnapshot = snapshot;
  });
  try {
    completion = await runner.finalChatCompletion();
    message = await runner.finalMessage();
  } catch (err: any) {
    error = { name: String(err?.name ?? err?.constructor?.name ?? 'Error'), message: String(err?.message ?? err) };
  }
  return { completion, message, error, eventTypes, sawDoneSentinel, lastSnapshot };
}
