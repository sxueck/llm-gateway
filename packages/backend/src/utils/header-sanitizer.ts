const RESERVED_HEADER_NAMES = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
]);

export type HeaderValue = string | number | boolean | null | undefined;
export type HeaderInput = Record<string, HeaderValue>;
export type SanitizedHeaders = Record<string, string>;

/**
 * 移除会影响 HTTP 传输的危险头，保证只保留安全的固定请求头
 */
export function sanitizeCustomHeaders(headers?: HeaderInput | null): SanitizedHeaders | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  const sanitized: SanitizedHeaders = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (!rawKey) continue;

    const key = rawKey.trim();
    if (!key) continue;

    const lowerKey = key.toLowerCase();
    if (RESERVED_HEADER_NAMES.has(lowerKey)) {
      continue;
    }

    const value =
      rawValue === undefined || rawValue === null ? '' : String(rawValue).trim();

    if (!value) continue;

    sanitized[key] = value;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function getSanitizedHeadersCacheKey(headers?: SanitizedHeaders): string {
  if (!headers || Object.keys(headers).length === 0) return '';
  return Object.keys(headers)
    .sort()
    .map(key => `${key}:${headers[key]}`)
    .join('|');
}

/**
 * Filter client-forwarded headers so they cannot override configured default headers.
 *
 * - Both inputs are sanitized via sanitizeCustomHeaders
 * - Comparison is case-insensitive
 * - Returns undefined when nothing should be forwarded
 */
export function filterForwardedHeaders(
  defaultHeaders: unknown,
  forwardedHeaders: unknown
): Record<string, string> | undefined {
  const forwarded = sanitizeCustomHeaders(forwardedHeaders as any);
  if (!forwarded || Object.keys(forwarded).length === 0) {
    return undefined;
  }

  const defaults = sanitizeCustomHeaders(defaultHeaders as any);
  if (!defaults || Object.keys(defaults).length === 0) {
    return forwarded;
  }

  const defaultKeys = new Set(Object.keys(defaults).map(k => k.toLowerCase()));
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(forwarded)) {
    if (defaultKeys.has(k.toLowerCase())) continue;
    filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
