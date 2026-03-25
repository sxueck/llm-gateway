/**
 * Shared upstream proxy configuration and utilities.
 * Supports HTTP_PROXY, HTTPS_PROXY, NO_PROXY (and lowercase variants).
 */

export interface ProxyConfig {
  httpProxyUrl: string | null;
  httpsProxyUrl: string | null;
  noProxy: string[];
}

/**
 * Get proxy configuration from environment variables.
 * Priority: uppercase > lowercase
 */
export function getProxyConfigFromEnv(): ProxyConfig {
  const httpProxyUrl = process.env.HTTP_PROXY || process.env.http_proxy || null;
  const httpsProxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const noProxyRaw = process.env.NO_PROXY || process.env.no_proxy || '';

  const noProxy = noProxyRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return {
    httpProxyUrl,
    httpsProxyUrl,
    noProxy,
  };
}

/**
 * Check if a hostname matches a NO_PROXY pattern.
 * Supports:
 * - Exact hostname match
 * - Domain suffix match (e.g., ".example.com" matches "api.example.com")
 * - Wildcard "*" matches all
 * - Subdomain patterns without leading dot (e.g., "example.com" matches "example.com" and subdomains)
 */
export function isHostInNoProxy(hostname: string, noProxyPatterns: string[]): boolean {
  if (!hostname || noProxyPatterns.length === 0) {
    return false;
  }

  const normalizedHost = hostname.toLowerCase();

  for (const pattern of noProxyPatterns) {
    const normalizedPattern = pattern.toLowerCase();

    // Wildcard matches everything
    if (normalizedPattern === '*') {
      return true;
    }

    // Exact match
    if (normalizedHost === normalizedPattern) {
      return true;
    }

    // Domain suffix match: pattern starts with "."
    if (normalizedPattern.startsWith('.')) {
      // e.g., pattern ".example.com" should match "api.example.com"
      if (normalizedHost.endsWith(normalizedPattern)) {
        return true;
      }
      // Also match if the hostname is exactly the pattern without the leading dot
      const patternWithoutDot = normalizedPattern.slice(1);
      if (normalizedHost === patternWithoutDot) {
        return true;
      }
    } else {
      // Pattern without leading dot should match exact hostname AND subdomains
      // e.g., pattern "example.com" should match "example.com" and "api.example.com"
      if (normalizedHost === normalizedPattern) {
        return true;
      }
      if (normalizedHost.endsWith('.' + normalizedPattern)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get the proxy URL for a given target URL based on proxy configuration.
 * Returns null if NO_PROXY matches or if no proxy is configured.
 */
export function getProxyUrlForTarget(targetUrl: string, proxyConfig: ProxyConfig): string | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }

  const hostname = url.hostname;
  const protocol = url.protocol;

  // Check NO_PROXY first
  if (isHostInNoProxy(hostname, proxyConfig.noProxy)) {
    return null;
  }

  // For HTTPS: use HTTPS_PROXY, fallback to HTTP_PROXY
  if (protocol === 'https:') {
    return proxyConfig.httpsProxyUrl || proxyConfig.httpProxyUrl || null;
  }

  // For HTTP: use HTTP_PROXY only
  if (protocol === 'http:') {
    return proxyConfig.httpProxyUrl || null;
  }

  return null;
}

/**
 * Check if proxy is configured in environment.
 */
export function isProxyConfigured(): boolean {
  const config = getProxyConfigFromEnv();
  return !!(config.httpProxyUrl || config.httpsProxyUrl);
}

/**
 * Determine if we're running in Bun environment.
 * Uses declaration to avoid TS errors when @types/bun isn't available.
 */
export function isBun(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).Bun !== 'undefined';
}
