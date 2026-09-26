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
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const parsed = parseSSEBlock(block);
      if (parsed) options.onEvent(parsed);
      separator = buffer.indexOf("\n\n");
    }
  }
}

function parseSSEBlock(block: string): SSEEvent | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
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
