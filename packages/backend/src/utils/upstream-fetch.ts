import {
  getProxyConfigFromEnv,
  getProxyUrlForTarget,
} from './upstream-proxy.js';
import { upstreamSslConfigService } from '../services/upstream-ssl-config.js';
import { memoryLogger } from '../services/logger.js';

// Lazy-loaded undici for Node.js runtime
let undici: typeof import('undici') | null = null;
let proxyAgentCache: Map<string, import('undici').ProxyAgent> = new Map();
let skipVerifyAgent: import('undici').Agent | null = null;

async function getUndici(): Promise<typeof import('undici')> {
  if (!undici) {
    undici = await import('undici');
  }
  return undici;
}

function getProxyAgentCacheKey(proxyUrl: string, skipVerify: boolean): string {
  return `${proxyUrl}|skipVerify=${skipVerify}`;
}

function getProxyAgent(proxyUrl: string, skipVerify: boolean): Promise<import('undici').ProxyAgent> {
  const cacheKey = getProxyAgentCacheKey(proxyUrl, skipVerify);
  const cached = proxyAgentCache.get(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  return getUndici().then((u) => {
    const agentOptions: any = {
      uri: proxyUrl,
    };
    if (skipVerify) {
      agentOptions.requestTls = { rejectUnauthorized: false };
    }
    const agent = new u.ProxyAgent(agentOptions);
    proxyAgentCache.set(cacheKey, agent);
    return agent;
  });
}

async function getSkipVerifyAgent(): Promise<import('undici').Agent> {
  if (!skipVerifyAgent) {
    const u = await getUndici();
    skipVerifyAgent = new u.Agent({
      connect: { rejectUnauthorized: false },
    });
  }
  return skipVerifyAgent;
}

export function clearProxyAgentCache(): void {
  proxyAgentCache.clear();
  skipVerifyAgent = null;
}

export interface UpstreamFetchOptions extends RequestInit {
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

function buildHeaders(
  defaultHeaders: Record<string, string>,
  requestHeaders?: RequestInit['headers']
): Record<string, string> {
  const merged: Record<string, string> = { ...defaultHeaders };

  if (requestHeaders) {
    if (requestHeaders instanceof Headers) {
      requestHeaders.forEach((value, key) => {
        merged[key] = value;
      });
    } else if (Array.isArray(requestHeaders)) {
      for (const [key, value] of requestHeaders) {
        merged[key] = value;
      }
    } else {
      Object.assign(merged, requestHeaders);
    }
  }

  return merged;
}

function createComposedAbortSignal(timeoutMs: number, existingSignal?: AbortSignal): AbortSignal | null {
  if (existingSignal?.aborted) {
    return null;
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (existingSignal) {
      existingSignal.removeEventListener('abort', onExistingAbort);
    }
  };

  const onExistingAbort = () => {
    cleanup();
    controller.abort();
  };

  timeoutId = setTimeout(() => {
    timeoutId = null;
    controller.abort();
    cleanup();
  }, timeoutMs);

  if (existingSignal) {
    existingSignal.addEventListener('abort', onExistingAbort, { once: true });
  }

  const signal = controller.signal;
  // Store cleanup on the signal so it can be called after the request completes
  (signal as any).__upstreamFetchCleanup = cleanup;

  return signal;
}

function cleanupComposedSignal(signal: AbortSignal | undefined): void {
  if (signal && (signal as any).__upstreamFetchCleanup) {
    (signal as any).__upstreamFetchCleanup();
  }
}

export function extractUrlString(url: string | URL | Request): string {
  if (typeof url === 'string') {
    return url;
  }

  if (url instanceof URL) {
    return url.toString();
  }

  if (url instanceof Request) {
    return url.url;
  }

  return String(url);
}

/**
 * Extract origin from a URL string for safe logging.
 * Removes path, query, and fragment to avoid leaking API keys or tokens.
 */
function sanitizeUrlForLog(urlString: string): string {
  try {
    const url = new URL(urlString);
    return url.origin;
  } catch {
    return urlString.replace(/\/\/.*@/, '//***@');
  }
}

/**
 * Convert Request object to RequestInit options.
 * Preserves all relevant request properties, including non-standard ones
 * used by undici (e.g. duplex) and SDK custom fetch.
 */
export function requestToInit(request: Request): RequestInit {
  const init: RequestInit & Record<string, any> = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    mode: request.mode,
    credentials: request.credentials,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    signal: request.signal,
  };

  // Preserve non-standard but important properties used by undici / SDKs
  const extraProps = ['cache', 'keepalive', 'duplex', 'priority'];
  for (const prop of extraProps) {
    if ((request as any)[prop] !== undefined) {
      init[prop] = (request as any)[prop];
    }
  }

  return init;
}

/**
 * Convert standard RequestInit to undici RequestInit.
 * Strips gateway-internal fields (timeoutMs) and injects the dispatcher.
 * Automatically adds duplex: 'half' when body is a ReadableStream.
 */
export function toUndiciRequestInit(
  fetchOptions: RequestInit,
  dispatcher: import('undici').Dispatcher
): import('undici').RequestInit {
  const { timeoutMs: _timeoutMs, ...requestOptions } = fetchOptions as RequestInit & { timeoutMs?: number };
  const body = requestOptions.body;
  const needsDuplex =
    typeof globalThis.ReadableStream !== 'undefined' &&
    body instanceof globalThis.ReadableStream &&
    (requestOptions as any).duplex === undefined;

  return {
    ...(requestOptions as import('undici').RequestInit),
    ...(needsDuplex ? { duplex: 'half' as any } : {}),
    dispatcher,
  };
}

/**
 * Determine the transport branch label for diagnostics.
 */
function getTransportBranch(proxyUrl: string | null, skipVerify: boolean): string {
  if (proxyUrl) return skipVerify ? 'proxy+skipVerify+undici' : 'proxy+undici';
  if (skipVerify) return 'direct+skipVerify+undici';
  return 'direct+nativeFetch';
}

/**
 * Log upstream connection errors with diagnostic context.
 * Sanitizes URL and proxy credentials.
 */
function logUpstreamConnectionError(
  error: any,
  context: {
    urlString: string;
    proxyUrl: string | null;
    skipVerify: boolean;
    method?: string;
  }
): void {
  const cause = error?.cause;
  const sanitizedOrigin = sanitizeUrlForLog(context.urlString);
  const sanitizedProxy = context.proxyUrl
    ? context.proxyUrl.replace(/\/\/.*@/, '//***@')
    : null;

  const diagnostic: Record<string, any> = {
    message: error?.message,
    causeMessage: cause?.message,
    causeCode: cause?.code,
    targetOrigin: sanitizedOrigin,
    proxyMatched: sanitizedProxy ? 'yes' : 'no',
    proxyUrl: sanitizedProxy,
    skipVerify: context.skipVerify,
    transportBranch: getTransportBranch(context.proxyUrl, context.skipVerify),
    method: context.method,
  };

  if (error?.name) diagnostic.errorName = error.name;
  if (error?.code) diagnostic.errorCode = error.code;

  memoryLogger.error(
    `Upstream connection failed: ${error?.message || 'Unknown error'}`,
    'UpstreamFetch',
    diagnostic
  );
}

export async function upstreamFetch(
  url: string | URL | Request,
  options: UpstreamFetchOptions = {}
): Promise<Response> {
  const urlString = extractUrlString(url);

  const proxyConfig = getProxyConfigFromEnv();
  const proxyUrl = getProxyUrlForTarget(urlString, proxyConfig);

  let fetchOptions: RequestInit;
  if (url instanceof Request) {
    const requestInit = requestToInit(url);
    fetchOptions = {
      ...requestInit,
      ...options,
      headers: options.headers || requestInit.headers,
    };
  } else {
    fetchOptions = { ...options };
  }

  let composedSignal: AbortSignal | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    const signal = createComposedAbortSignal(options.timeoutMs, options.signal ?? undefined);
    if (signal) {
      composedSignal = signal;
      fetchOptions.signal = composedSignal;
    } else {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
  }
  // If no timeout but has signal, it's already in fetchOptions from the spread above

  const skipVerify = upstreamSslConfigService.isSkipVerify();

  try {
    if (proxyUrl) {
      const agent = await getProxyAgent(proxyUrl, skipVerify);
      const u = await getUndici();
      const undiciOptions = toUndiciRequestInit(fetchOptions, agent);
      return await u.fetch(urlString, undiciOptions) as unknown as Response;
    }

    if (skipVerify) {
      const agent = await getSkipVerifyAgent();
      const u = await getUndici();
      const undiciOptions = toUndiciRequestInit(fetchOptions, agent);
      return await u.fetch(urlString, undiciOptions) as unknown as Response;
    }

    return await fetch(urlString, fetchOptions);
  } catch (error: any) {
    logUpstreamConnectionError(error, {
      urlString,
      proxyUrl,
      skipVerify,
      method: fetchOptions.method,
    });
    throw error;
  } finally {
    cleanupComposedSignal(composedSignal);
  }
}

export async function upstreamJsonPost<T = any>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
  options?: Omit<UpstreamFetchOptions, 'method' | 'body' | 'headers'>
): Promise<T> {
  const defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const mergedHeaders = buildHeaders(defaultHeaders, headers);

  const response = await upstreamFetch(url, {
    ...options,
    method: 'POST',
    headers: mergedHeaders,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 500)}`);
  }

  return response.json() as Promise<T>;
}

export async function upstreamJsonGet<T = any>(
  url: string,
  headers?: Record<string, string>,
  options?: Omit<UpstreamFetchOptions, 'method' | 'body' | 'headers'>
): Promise<T> {
  const response = await upstreamFetch(url, {
    ...options,
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 500)}`);
  }

  return response.json() as Promise<T>;
}
