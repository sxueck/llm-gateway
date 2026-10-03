// fetch 流式 SSE 读取：原生 EventSource 无法携带 Authorization header，
// admin 事件流（/api/admin/agent-runs/:id/events）走 JWT，必须用 fetch 实现。
// 协议解析遵循 SSE 规范的子集：id:/event:/data: 行，块以空行分隔，冒号开头为注释。

export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
}

export interface StreamSSEOptions {
  token?: string;
  lastEventId?: string;
  signal?: AbortSignal;
  onEvent: (event: SSEEvent) => void;
}

export async function streamSSE(
  url: string,
  options: StreamSSEOptions,
): Promise<void> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.lastEventId) headers["last-event-id"] = options.lastEventId;

  const response = await fetch(url, { headers, signal: options.signal });
  if (!response.ok || !response.body) {
    throw new Error(`SSE connect failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEFrameParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      options.onEvent(event);
    }
  }
}

// CRLF 必须作为一次换行处理，避免正则回溯将单个 CRLF 误判为空行。
export class SSEFrameParser {
  private buffer = "";

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const { frames, rest } = takeFrames(this.buffer);
    this.buffer = rest;
    const events: SSEEvent[] = [];
    for (const block of frames) {
      const parsed = parseSSEBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

interface LineBreak {
  index: number;
  length: number;
}

// 缓冲末尾的 CR 可能是跨 chunk 的 CRLF 前半段，需等下一块才能判定。
function findLineBreak(text: string, from: number): LineBreak | null {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\n") return { index: i, length: 1 };
    if (text[i] === "\r") {
      if (i + 1 === text.length) return null;
      return { index: i, length: text[i + 1] === "\n" ? 2 : 1 };
    }
  }
  return null;
}

function takeFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let frameStart = 0;
  let lineStart = 0;
  let blockEnd = 0;
  let scan = 0;
  for (;;) {
    const br = findLineBreak(buffer, scan);
    if (!br) break;
    const next = br.index + br.length;
    if (br.index === lineStart) {
      frames.push(buffer.slice(frameStart, blockEnd));
      frameStart = lineStart = blockEnd = next;
    } else {
      blockEnd = br.index;
      lineStart = next;
    }
    scan = next;
  }
  return { frames, rest: buffer.slice(frameStart) };
}

function parseSSEBlock(block: string): SSEEvent | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of splitLines(block)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0 && id === undefined && event === undefined) {
    return null;
  }
  return { id, event, data: dataLines.join("\n") };
}

function splitLines(block: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const br = findLineBreak(block, start);
    if (!br) break;
    lines.push(block.slice(start, br.index));
    start = br.index + br.length;
  }
  lines.push(block.slice(start));
  return lines;
}
