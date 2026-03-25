/**
 * Upstream fetch wrapper with proxy support.
 * Provides a unified interface for making HTTP requests with proxy support.
 * 
 * Runtime-specific implementation:
 * - Bun: Uses native `proxy` option in fetch
 * - Node.js: Uses undici's ProxyAgent
 */

import {
  getProxyConfigFromEnv,
  getProxyUrlForTarget,
  isBun,
} from './upstream-proxy.js';

// Lazy-loaded undici for Node.js runtime
let undici: typeof import('undici') | null = null;
let proxyAgentCache: Map<string, import('undici').ProxyAgent> = new Map();

async function getUndici(): Promise<typeof import('undici')> {
  if (!undici) {
    undici = await import('undici');
  }
  return undici;
}

function getProxyAgent(proxyUrl: string): Promise<import('undici').ProxyAgent> {
  const cached = proxyAgentCache.get(proxyUrl);
  if (cached) {
    return Promise.resolve(cached);
  }

  return getUndici().then((u) => {
    const agent = new u.ProxyAgent({
      uri: proxyUrl,
    });
    proxyAgentCache.set(proxyUrl, agent);
    return agent;
  });
}

export interface UpstreamFetchOptions extends RequestInit {
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Build headers for upstream request, merging defaults with provided headers.
 */
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

/**
 * Create an AbortSignal with timeout that properly composes with an existing signal.
 * 
 * Features:
 * - Returns null immediately if the existing signal is already aborted
 * - Clears timeout when existing signal aborts (to prevent memory leaks)
 * - Aborts composed signal when either timeout fires or existing signal aborts
 * - Cleans up resources on successful completion
 */
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

/**
 * Extract URL string from various input types.
 * Handles string, URL, and Request objects properly.
 */
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
 * Convert Request object to RequestInit options.
 * Preserves all relevant request properties.
 */
function requestToInit(request: Request): RequestInit {
  // Extract properties from Request, using type assertions for non-standard properties
  return {
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
    // Include additional properties that may be present
    ...(request as any).cache !== undefined && { cache: (request as any).cache },
    ...(request as any).keepalive !== undefined && { keepalive: (request as any).keepalive },
  };
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

  try {
    // Runtime-specific proxy handling
    if (proxyUrl) {
      if (isBun()) {
        // Bun: Use native proxy option
        (fetchOptions as any).proxy = proxyUrl;
        return await fetch(urlString, fetchOptions);
      } else {
        // Node.js: Use undici with ProxyAgent
        const agent = await getProxyAgent(proxyUrl);
        const u = await getUndici();
        
        // Use undici's fetch with dispatcher
        // Cast to Response to handle type differences between undici and standard fetch
        const undiciOptions: import('undici').RequestInit = {
          method: fetchOptions.method,
          headers: fetchOptions.headers as import('undici').HeadersInit,
          body: fetchOptions.body as import('undici').BodyInit,
          redirect: fetchOptions.redirect as import('undici').RequestRedirect,
          signal: fetchOptions.signal,
          dispatcher: agent,
        };
        return await u.fetch(urlString, undiciOptions) as unknown as Response;
      }
    }

    // No proxy: use standard fetch
    return await fetch(urlString, fetchOptions);
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

/**
 * Make a JSON GET request with automatic proxy support.
 *
 * @param url Target URL
 * @param headers Optional headers
 * @param options Optional fetch options
 * @returns Parsed JSON response
 */
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
