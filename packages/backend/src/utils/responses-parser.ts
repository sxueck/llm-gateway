export type ResponsesStatus = 'in_progress' | 'completed' | 'incomplete' | 'cancelled' | 'errored' | 'unknown';

export interface ResponsesUsageDetails {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ResponsesStreamEvent {
  type?: string;
  event_id?: string;
  response?: {
    id?: string;
    object?: string;
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
  usage?: ResponsesUsageDetails;
  response_id?: string;
  delta?: Record<string, any>;
  output_text?: Record<string, any>;
  text?: string;
  error?: {
    type?: string;
    message?: string;
    code?: string | number;
  };
  sequence_number?: number;
  timestamp?: string | number;
}

export interface ResponsesAggregate {
  id?: string;
  model?: string;
  status: ResponsesStatus;
  outputText: string;
  usage?: ResponsesUsageDetails;
  lastEventType?: string;
}

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

function extractTextDelta(ev: ResponsesStreamEvent): string {
  if (!ev) return '';

  const type = ev.type || '';
  const isOutputTextEvent = type.startsWith('response.output_text.');
  const isLegacyShapeWithoutType = !type;

  if (type.includes('output_text.delta')) {
    const txt = ev.delta?.text ?? ev.text;
    if (typeof txt === 'string') return txt;
  }

  if ((isOutputTextEvent || isLegacyShapeWithoutType) && typeof ev.text === 'string') {
    return ev.text;
  }

  const ot = ev.output_text as any;
  if ((isOutputTextEvent || isLegacyShapeWithoutType) && ot && typeof ot.text === 'string') {
    return ot.text;
  }

  return '';
}

function mergeUsage(
  prev: ResponsesUsageDetails | undefined,
  next?: ResponsesUsageDetails
): ResponsesUsageDetails | undefined {
  if (!next) return prev;
  const merged: ResponsesUsageDetails = { ...(prev || {}), ...next };

  const baseInput = next.input_tokens ?? (next as any).prompt_tokens ?? merged.input_tokens ?? 0;
  const cached =
    (next.input_tokens_details?.cached_tokens ?? 0) ||
    (next.prompt_tokens_details?.cached_tokens ?? 0);

  if ((next.input_tokens ?? 0) === 0 && cached > 0) {
    merged.input_tokens = baseInput + cached;
  } else {
    merged.input_tokens = next.input_tokens ?? merged.input_tokens;
  }

  if (typeof next.output_tokens === 'number') merged.output_tokens = next.output_tokens;
  if (typeof next.total_tokens === 'number') merged.total_tokens = next.total_tokens;

  return merged;
}

export function processResponsesEvent(
  aggregate: ResponsesAggregate,
  event: ResponsesStreamEvent
): ResponsesAggregate {
  let next: ResponsesAggregate = { ...aggregate, lastEventType: event.type };

  if (event.type === 'response.created' && event.response) {
    next.id = event.response.id || aggregate.id;
    next.model = event.response.model || aggregate.model;
    next.status = normalizeStatus(event.response.status) || next.status;
    next.usage = mergeUsage(next.usage, event.response.usage || undefined);
  }

  const deltaText = extractTextDelta(event);
  if (deltaText) {
    next.outputText = (next.outputText || '') + deltaText;
  }

  if (event.usage) {
    next.usage = mergeUsage(next.usage, event.usage);
  }

  if (event.type === 'response.done' || event.type === 'response.completed') {
    const explicit = normalizeStatus((event.response as any)?.status || 'completed');
    next.status = explicit === 'unknown' ? 'completed' : explicit;

    if ((event as any).response?.usage) {
      next.usage = mergeUsage(next.usage, (event as any).response.usage);
    }
  }

  if (event.type === 'response.error' || event.error) {
    next.status = 'errored';
  }

  return next;
}
