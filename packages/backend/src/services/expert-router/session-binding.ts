import { parsePositiveInt } from '../../utils/parse-positive-int.js';

const DEFAULT_MAX_EXPERT_ROUTING_SESSION_BINDINGS = 20000;

const MAX_EXPERT_ROUTING_SESSION_BINDINGS = parsePositiveInt(
  process.env.MAX_EXPERT_ROUTING_SESSION_BINDINGS,
  DEFAULT_MAX_EXPERT_ROUTING_SESSION_BINDINGS
);

interface SessionCategoryBinding {
  category: string;
  updatedAt: number;
}

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

export class ExpertRoutingSessionBindingStore {
  private readonly bindings = new Map<string, SessionCategoryBinding>();

  constructor(private readonly maxEntries = MAX_EXPERT_ROUTING_SESSION_BINDINGS) {}

  get size(): number {
    return this.bindings.size;
  }

  get(expertRoutingId: string, virtualKeyId: string | undefined, sessionId: string): string | undefined {
    const key = this.buildKey(expertRoutingId, virtualKeyId, sessionId);
    const binding = this.bindings.get(key);
    if (!binding) return undefined;

    this.bindings.delete(key);
    this.bindings.set(key, { ...binding, updatedAt: Date.now() });
    return binding.category;
  }

  set(expertRoutingId: string, virtualKeyId: string | undefined, sessionId: string, category: string): void {
    const normalizedCategory = category.trim();
    if (!normalizedCategory) return;

    const key = this.buildKey(expertRoutingId, virtualKeyId, sessionId);
    if (this.bindings.has(key)) {
      this.bindings.delete(key);
    }
    this.bindings.set(key, { category: normalizedCategory, updatedAt: Date.now() });
    this.evictOverflow();
  }

  delete(expertRoutingId: string, virtualKeyId: string | undefined, sessionId: string): void {
    this.bindings.delete(this.buildKey(expertRoutingId, virtualKeyId, sessionId));
  }

  clear(): void {
    this.bindings.clear();
  }

  private buildKey(expertRoutingId: string, virtualKeyId: string | undefined, sessionId: string): string {
    return `${expertRoutingId}:${virtualKeyId || 'anonymous'}:${sessionId}`;
  }

  private evictOverflow(): void {
    while (this.bindings.size > this.maxEntries) {
      const oldestKey = this.bindings.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.bindings.delete(oldestKey);
    }
  }
}

export const expertRoutingSessionBindings = new ExpertRoutingSessionBindingStore();
