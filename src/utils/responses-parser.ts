/**
 * Lightweight parser and state machine for OpenAI Responses API streaming events.
 * Focus:
 * - Event typing (response.created/response.done/…)
 * - Status aggregation (in_progress/completed/incomplete/cancelled)
 * - Text accumulation for output_text.* events when present
 * - Usage snapshot tracking when available
 */

export type ResponsesStatus = 'in_progress' | 'completed' | 'incomplete' | 'cancelled' | 'errored' | 'unknown';

export interface ResponsesUsageDetails {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number }; // compat alias sometimes used upstream
}

/**
 * Generic event envelope seen in streaming Responses API.
 * Different docs variants exist; we accept superset with safe optional fields.
 */
export interface ResponsesStreamEvent {
  // Event type, examples:
  // - 'response.created'
  // - 'response.completed' / 'response.done'
  // - 'response.output_text.delta'
  // - 'response.output_text.done'
  // - 'response.refusal.delta'
  // - 'response.error'
  // - 'rate_limits.updated'
  type?: string;

  // Server-side unique id for event (if provided)
  event_id?: string;

  // Canonical response object at creation time for response.created
  response?: {
    id?: string;
    object?: string; // e.g., 'response' or 'realtime.response'
    created_at?: number;
    status?: ResponsesStatus | string;
    status_details?: string | null;
    model?: string;
    output?: any[];
    conversation_id?: string;
    output_modalities?: string[];
    max_output_tokens?: number | string;
    usage?: ResponsesUsageDetails | null;
    metadata?: Record<string, any> | null;
  };

  // Many events include usage directly on the event root
  usage?: ResponsesUsageDetails;

  // Some variants use 'response_id' rather than nesting
  response_id?: string;

  // Text deltas often appear as:
  // { type: 'response.output_text.delta', delta: { text: '...' } }
  delta?: Record<string, any>;

  // Some payloads may use fields like:
  // { output_text: { ... }, text: '...' }
  output_text?: Record<string, any>;
  text?: string;

  // Error envelope for 'response.error'
  error?: {
    type?: string;
    message?: string;
    code?: string | number;
  };

  // For sequence ordering in some doc variants
  sequence_number?: number;

  // Timestamp (string or number depending on source)
  timestamp?: string | number;
}

/**
 * Aggregated state we build from the stream.
 */
export interface ResponsesAggregate {
  id?: string;
  model?: string;
  status: ResponsesStatus;
  outputText: string; // accumulated textual output if present
  usage?: ResponsesUsageDetails;
  lastEventType?: string;
}

/**
 * Initialize an aggregate.
 */
export function createInitialAggregate(): ResponsesAggregate {
  return {
    id: undefined,
    model: undefined,
    status: 'unknown',
    outputText: '',
    usage: undefined,
    lastEventType: undefined,
  };
}

/**
 * Normalize status strings from various docs/implementations.
 */
function normalizeStatus(raw?: string | null): ResponsesStatus {
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase();
  if (s.includes('in_progress')) return 'in_progress';
  if (s.includes('complete')) return 'completed';
  if (s.includes('incomplete')) return 'incomplete';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('error') || s.includes('failed')) return 'errored';
  return 'unknown';
}

/**
 * Attempt to extract a text delta from an arbitrary event.
 * We support multiple shapes to be robust to doc variations.
 */
function extractTextDelta(ev: ResponsesStreamEvent): string {
  // Primary: event.type like 'response.output_text.delta' with ev.delta.text
  if (ev.type?.includes('output_text.delta')) {
    const txt = ev.delta?.text ?? ev.text;
    if (typeof txt === 'string') return txt;
  }

  // Fallback: some implementations put 'text' directly with type hints
  if (typeof ev.text === 'string') return ev.text;

  // Fallback: output_text may contain delta-like payloads
  // Try common fields defensively
  const ot = ev.output_text as any;
  if (ot && typeof ot.text === 'string') return ot.text;

  return '';
}

/**
 * Merge usage with cache token details in a conservative manner.
 * We only add cached tokens if base is 0 to avoid double counting (same policy as proxy-handler).
 */
function mergeUsage(prev: ResponsesUsageDetails | undefined, next?: ResponsesUsageDetails): ResponsesUsageDetails | undefined {
  if (!next) return prev;
  const merged: ResponsesUsageDetails = { ...(prev || {}), ...next };

  const baseInput = next.input_tokens ?? (next as any).prompt_tokens ?? merged.input_tokens ?? 0;
  const cached =
    (next.input_tokens_details?.cached_tokens ?? 0) ||
    (next.prompt_tokens_details?.cached_tokens ?? 0);

  // Only add cached tokens if base is zero (defensive)
  if ((next.input_tokens ?? 0) === 0 && cached > 0) {
    merged.input_tokens = baseInput + cached;
  } else {
    merged.input_tokens = next.input_tokens ?? merged.input_tokens;
  }

  if (typeof next.output_tokens === 'number') merged.output_tokens = next.output_tokens;
  if (typeof next.total_tokens === 'number') merged.total_tokens = next.total_tokens;

  return merged;
}

/**
 * Process a single Responses API stream event, updating the aggregate.
 * This is side-effect-free: returns a new object.
 */
export function processResponsesEvent(
  aggregate: ResponsesAggregate,
  event: ResponsesStreamEvent
): ResponsesAggregate {
  let next: ResponsesAggregate = { ...aggregate, lastEventType: event.type };

  // response.created carries the canonical response object
  if (event.type === 'response.created' && event.response) {
    next.id = event.response.id || aggregate.id;
    next.model = event.response.model || aggregate.model;
    next.status = normalizeStatus(event.response.status) || next.status;
    next.usage = mergeUsage(next.usage, event.response.usage || undefined);
  }

  // Accumulate text if present
  const deltaText = extractTextDelta(event);
  if (deltaText) {
    next.outputText = (next.outputText || '') + deltaText;
  }

  // Usage updates may appear on the root event
  if (event.usage) {
    next.usage = mergeUsage(next.usage, event.usage);
  }

  // Completion and terminal statuses
  // Some docs say 'response.done', others 'response.completed'
  if (event.type === 'response.done' || event.type === 'response.completed') {
    // If upstream supplies explicit status, normalize; else treat as completed
    const explicit = normalizeStatus((event.response as any)?.status || 'completed');
    next.status = explicit === 'unknown' ? 'completed' : explicit;

    // On done, if usage present only at the end, capture it
    if ((event as any).response?.usage) {
      next.usage = mergeUsage(next.usage, (event as any).response.usage);
    }
  }

  // Error event
  if (event.type === 'response.error' || event.error) {
    next.status = 'errored';
  }

  return next;
}

/**
 * Simple helper to map aggregate to a completion-like usage result,
 * keeping compatibility with existing token counters.
 */
export function summarizeUsage(usage?: ResponsesUsageDetails): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = typeof usage?.total_tokens === 'number' ? usage!.total_tokens! : (prompt + completion);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
  };
}