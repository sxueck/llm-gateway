import crypto from 'crypto';

interface NormalizedMessage {
  role: string;
  content: string;
  name?: string;
  function_call?: any;
  tool_calls?: any;
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
}

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

  return messages.map(msg => {
    const normalized: NormalizedMessage = {
      role: normalizeString(msg.role) || 'user',
      content: '',
    };

    if (typeof msg.content === 'string') {
      normalized.content = normalizeString(msg.content) || '';
    } else if (Array.isArray(msg.content)) {
      normalized.content = JSON.stringify(msg.content);
    } else if (msg.content && typeof msg.content === 'object') {
      normalized.content = JSON.stringify(msg.content);
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

export function generateCacheKey(
  requestBody: any,
  virtualKeyId: string
): string {
  const normalized: NormalizedRequestBody = {
    virtual_key_id: virtualKeyId,
    model: normalizeString(requestBody.model?.toLowerCase()) || 'unknown',
    messages: normalizeMessages(requestBody.messages || []),
    temperature: normalizeFloat(requestBody.temperature),
    max_tokens: requestBody.max_tokens,
    top_p: normalizeFloat(requestBody.top_p),
    frequency_penalty: normalizeFloat(requestBody.frequency_penalty),
    presence_penalty: normalizeFloat(requestBody.presence_penalty),
    stop: normalizeStop(requestBody.stop),
    n: requestBody.n,
  };

  const sortedKeys = Object.keys(normalized).sort();
  const sortedObj: any = {};
  
  for (const key of sortedKeys) {
    const value = (normalized as any)[key];
    if (value !== undefined && value !== null) {
      sortedObj[key] = value;
    }
  }

  const jsonString = JSON.stringify(sortedObj);
  const hash = crypto.createHash('md5').update(jsonString).digest('hex');

  return hash;
}

export function generateCacheKeyWithDebug(
  requestBody: any,
  virtualKeyId: string
): { key: string; normalized: any; json: string } {
  const normalized: NormalizedRequestBody = {
    virtual_key_id: virtualKeyId,
    model: normalizeString(requestBody.model?.toLowerCase()) || 'unknown',
    messages: normalizeMessages(requestBody.messages || []),
    temperature: normalizeFloat(requestBody.temperature),
    max_tokens: requestBody.max_tokens,
    top_p: normalizeFloat(requestBody.top_p),
    frequency_penalty: normalizeFloat(requestBody.frequency_penalty),
    presence_penalty: normalizeFloat(requestBody.presence_penalty),
    stop: normalizeStop(requestBody.stop),
    n: requestBody.n,
  };

  const sortedKeys = Object.keys(normalized).sort();
  const sortedObj: any = {};
  
  for (const key of sortedKeys) {
    const value = (normalized as any)[key];
    if (value !== undefined && value !== null) {
      sortedObj[key] = value;
    }
  }

  const jsonString = JSON.stringify(sortedObj);
  const hash = crypto.createHash('md5').update(jsonString).digest('hex');

  return {
    key: hash,
    normalized: sortedObj,
    json: jsonString,
  };
}

