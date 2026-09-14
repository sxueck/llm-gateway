import crypto from 'crypto';

interface NormalizedMessage {
  role: string;
  content: unknown;
  name?: string;
  function_call?: unknown;
  tool_calls?: unknown;
}

interface NormalizedRequestBody {
  virtual_key_id: string;
  model: string;
  messages: NormalizedMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
  reasoning_effort?: string;
  [key: string]: unknown;
}

/**
 * Fields consumed by the explicit normalizers in `buildNormalized`. Every other
 * request field flows through `extractRemainder` and participates in the cache
 * key, so any control that can affect model output yields a distinct key.
 */
const NORMALIZED_FIELDS: ReadonlySet<string> = new Set([
  'virtual_key_id',
  'model',
  'messages',
  'temperature',
  'max_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'n',
  'reasoning_effort',
]);

/**
 * Transport-only fields that cannot change the model output and must not
 * fragment the cache. `stream` is excluded because the response cache never
 * serves streaming requests, and `stream_options` only applies to streams.
 */
const EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  'stream',
  'stream_options',
]);

function normalizeFloat(value: number | undefined, precision: number = 3): number | undefined {
  if (value === undefined || value === null) return undefined;
  return Math.round(value * Math.pow(10, precision)) / Math.pow(10, precision);
}

function normalizeString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim();
}

function normalizeMessages(messages: any[]): NormalizedMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((msg: any) => {
    const normalized: NormalizedMessage = {
      role: normalizeString(msg.role) || 'user',
      content: '',
    };

    if (typeof msg.content === 'string') {
      normalized.content = normalizeString(msg.content) || '';
    } else if (Array.isArray(msg.content)) {
      // Kept structured; `canonicalize` sorts nested object keys before hashing.
      normalized.content = msg.content;
    } else if (msg.content && typeof msg.content === 'object') {
      normalized.content = msg.content;
    } else {
      normalized.content = String(msg.content || '');
    }

    if (msg.name) {
      normalized.name = normalizeString(msg.name);
    }

    if (msg.function_call) {
      normalized.function_call = msg.function_call;
    }

    if (msg.tool_calls) {
      normalized.tool_calls = msg.tool_calls;
    }

    return normalized;
  });
}

function normalizeStop(stop: string | string[] | undefined): string | string[] | undefined {
  if (!stop) return undefined;
  
  if (typeof stop === 'string') {
    return normalizeString(stop);
  }
  
  if (Array.isArray(stop)) {
    return stop.map(s => normalizeString(s) || '').filter(s => s.length > 0);
  }
  
  return undefined;
}

/**
 * Recursively canonicalize a JSON-like value so semantically identical values
 * always serialize identically:
 * - object keys are sorted at every depth;
 * - arrays keep their order (order is semantic, e.g. message/tool ordering);
 * - `undefined` and `null` object values are dropped (explicit null is treated
 *   as absent, matching the previous top-level normalization);
 * - `undefined` inside arrays becomes null, matching JSON.stringify semantics.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => {
      const canonical = canonicalize(item);
      return canonical === undefined ? null : canonical;
    });
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const canonical = canonicalize(source[key]);
      if (canonical !== undefined && canonical !== null) {
        result[key] = canonical;
      }
    }
    return result;
  }

  return value;
}

/**
 * Collect every request field that is not explicitly normalized above and is
 * not a transport-only field. These still affect model output, so they must
 * participate in the cache key.
 */
function extractRemainder(requestBody: any): Record<string, unknown> {
  const remainder: Record<string, unknown> = {};
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    return remainder;
  }

  for (const key of Object.keys(requestBody)) {
    if (NORMALIZED_FIELDS.has(key) || EXCLUDED_FIELDS.has(key)) {
      continue;
    }
    remainder[key] = requestBody[key];
  }

  return remainder;
}

function buildNormalized(
  requestBody: any,
  virtualKeyId: string
): NormalizedRequestBody {
  const normalized: NormalizedRequestBody = {
    virtual_key_id: virtualKeyId,
    model: normalizeString(requestBody?.model?.toLowerCase()) || 'unknown',
    messages: normalizeMessages(requestBody?.messages || []),
    temperature: normalizeFloat(requestBody?.temperature),
    max_tokens: requestBody?.max_tokens,
    top_p: normalizeFloat(requestBody?.top_p),
    frequency_penalty: normalizeFloat(requestBody?.frequency_penalty),
    presence_penalty: normalizeFloat(requestBody?.presence_penalty),
    stop: normalizeStop(requestBody?.stop),
    n: requestBody?.n,
    reasoning_effort: normalizeString(requestBody?.reasoning_effort),
  };

  for (const [key, value] of Object.entries(extractRemainder(requestBody))) {
    normalized[key] = value;
  }

  return normalized;
}

function canonicalJson(normalized: NormalizedRequestBody): string {
  return JSON.stringify(canonicalize(normalized));
}

export function generateCacheKey(
  requestBody: any,
  virtualKeyId: string
): string {
  const jsonString = canonicalJson(buildNormalized(requestBody, virtualKeyId));
  return crypto.createHash('md5').update(jsonString).digest('hex');
}

export function generateCacheKeyWithDebug(
  requestBody: any,
  virtualKeyId: string
): { key: string; normalized: any; json: string } {
  const normalized = buildNormalized(requestBody, virtualKeyId);
  const jsonString = canonicalJson(normalized);
  const hash = crypto.createHash('md5').update(jsonString).digest('hex');

  return {
    key: hash,
    normalized: canonicalize(normalized),
    json: jsonString,
  };
}
