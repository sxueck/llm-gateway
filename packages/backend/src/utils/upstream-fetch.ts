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
  // If existing signal is already aborted, return null immediately
  if (existingSignal?.aborted) {
    return null;
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let isCleanedUp = false;

  // Cleanup function to prevent memory leaks
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

  // Handle existing signal abort
  const onExistingAbort = () => {
    cleanup();
    controller.abort();
  };

  // Set up timeout
  timeoutId = setTimeout(() => {
    timeoutId = null;
    controller.abort();
    cleanup();
  }, timeoutMs);

  // Listen to existing signal if provided
  if (existingSignal) {
    existingSignal.addEventListener('abort', onExistingAbort, { once: true });
  }

  // Return the signal with cleanup attached
  const signal = controller.signal;

  // Store cleanup on the signal so it can be called after the request completes
  (signal as any).__upstreamFetchCleanup = cleanup;

  return signal;
}

/**
 * Execute cleanup on a composed abort signal if one was created.
 */
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

  // It's a Request object - extract the URL
  if (url instanceof Request) {
    return url.url;
  }

  // Fallback for any other object with toString
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
    // If URL parsing fails, return a scrubbed version
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

  // Include error name/code if available
  if (error?.name) diagnostic.errorName = error.name;
  if (error?.code) diagnostic.errorCode = error.code;

  memoryLogger.error(
    `Upstream connection failed: ${error?.message || 'Unknown error'}`,
    'UpstreamFetch',
    diagnostic
  );
}

/**
 * Make an upstream HTTP request with automatic proxy support.
 *
 * Features:
 * - Automatic proxy detection from environment variables
 * - NO_PROXY support
 * - Timeout support
 * - Bun/Node runtime compatibility
 * - Preserves existing signal/headers/body/stream behavior
 * - Diagnostic logging on connection errors (sanitized)
 *
 * @param url Target URL (string, URL, or Request)
 * @param options Request options including optional timeoutMs
 * @returns Response from fetch
 */
export async function upstreamFetch(
  url: string | URL | Request,
  options: UpstreamFetchOptions = {}
): Promise<Response> {
  // Extract URL string properly
  const urlString = extractUrlString(url);

  const proxyConfig = getProxyConfigFromEnv();
  const proxyUrl = getProxyUrlForTarget(urlString, proxyConfig);

  // Build fetch options from Request if needed, otherwise use options directly
  let fetchOptions: RequestInit;
  if (url instanceof Request) {
    // If a Request was passed, extract its properties and merge with options
    const requestInit = requestToInit(url);
    fetchOptions = {
      ...requestInit,
      ...options,
      // Merge headers carefully
      headers: options.headers || requestInit.headers,
    };
  } else {
    // Otherwise use options directly
    fetchOptions = { ...options };
  }

  // Handle signal and timeout composition
  let composedSignal: AbortSignal | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    const signal = createComposedAbortSignal(options.timeoutMs, options.signal ?? undefined);
    // If signal is already aborted, composedSignal will be null
    if (signal) {
      composedSignal = signal;
      fetchOptions.signal = composedSignal;
    } else {
      // Signal was already aborted - throw AbortError
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
    // Log diagnostic info for connection errors, then re-throw
    logUpstreamConnectionError(error, {
      urlString,
      proxyUrl,
      skipVerify,
      method: fetchOptions.method,
    });
    throw error;
  } finally {
    // Always cleanup timeout/listeners after request completes (success or error)
    cleanupComposedSignal(composedSignal);
  }
}

/**
 * Make a JSON POST request with automatic proxy support.
 *
 * @param url Target URL
 * @param body Request body (will be JSON stringified)
 * @param headers Optional additional headers
 * @param options Optional fetch options
 * @returns Parsed JSON response
 */
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

/**
 * Check if a URL should use a proxy (useful for debugging).
 */
export function getProxyStatus(url: string): {
  configured: boolean;
  proxyUrl: string | null;
  noProxyMatch: boolean;
} {
  const proxyConfig = getProxyConfigFromEnv();
  const proxyUrl = getProxyUrlForTarget(url, proxyConfig);

  return {
    configured: !!(proxyConfig.httpProxyUrl || proxyConfig.httpsProxyUrl),
    proxyUrl,
    noProxyMatch: !!(proxyConfig.httpProxyUrl || proxyConfig.httpsProxyUrl) && !proxyUrl,
  };
}
