function normalizeSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  return value.length > 256 ? value.slice(0, 256) : value;
}

function headerValue(headers: Record<string, any>, name: string): unknown {
  return headers[name] ?? headers[name.toLowerCase()];
}

export function extractExpertRoutingSessionId(request?: any): string | undefined {
  const headers: Record<string, any> = request?.headers || {};
  const body: any = request?.body || {};

  const candidates: unknown[] = [
    headerValue(headers, 'x-session-id'),
    headerValue(headers, 'x-session-affinity'),
    body?.session_id,
    body?.sessionId,
    body?.metadata?.session_id,
    body?.metadata?.sessionId,
  ];

  for (const candidate of candidates) {
    const sessionId = normalizeSessionId(candidate);
    if (sessionId) return sessionId;
  }

  return undefined;
}
