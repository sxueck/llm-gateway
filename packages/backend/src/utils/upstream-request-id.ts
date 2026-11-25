export const UPSTREAM_REQUEST_ID_HEADER = 'X-Upstream-Request-Id';

/** Only expose bounded, printable upstream values as downstream headers. */
export function sanitizeUpstreamRequestId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null;
  if (!/^[\x20-\x7e]+$/.test(value)) return null;
  return value.trim() || null;
}
