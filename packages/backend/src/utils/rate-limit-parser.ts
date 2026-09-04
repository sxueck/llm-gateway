/**
 * 从上游 429 限流 / 配额消息中提取「重置时刻」的绝对时间戳（毫秒）。
 *
 * 支持来源（按优先级）：
 *   1. Retry-After 头：纯数字（秒）或 HTTP-date
 *   2. 消息正文里的 "reset at <datetime>"（OpenAI / LiteLLM 风格）
 *
 * 时区注意：消息形如
 *   "... It will reset at 2026-08-29 23:59:59 +0800 CST ..."
 * 其中 "CST" 是歧义缩写（同时指中国 +0800 与美国中部 -0600），
 * 这里只取明确的数字偏移量（+0800），忽略字母缩写，避免解析到错误的时区。
 */

/** 将 "+0800" / "+08:00" / "-0500" 归一化为 "+08:00" / "-05:00" */
function normalizeOffset(offset: string): string {
  const m = offset.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (m) {
    return `${m[1]}${m[2]}:${m[3]}`;
  }
  return offset;
}

function parseResetDateFromMessage(message: string): number | null {
  if (!message) return null;

  const m = message.match(
    /reset at\s+(\d{4}[-/]\d{2}[-/]\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}:?\d{2}))?/i
  );
  if (!m) return null;

  const datePart = m[1].replace(/\//g, '-');
  const timePart = m[2];
  const rawOffset = m[3];

  let iso = `${datePart}T${timePart}`;
  if (rawOffset) {
    iso += normalizeOffset(rawOffset);
  } else {
    // 无偏移量时先尝试按本地时区解析，失败再按 UTC 解析
    const local = Date.parse(`${datePart} ${timePart}`);
    if (!Number.isNaN(local)) return local;
    iso += 'Z';
  }

  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

/**
 * 提取限流 / 配额的重置时刻（绝对毫秒时间戳）。
 * 提取不到或日期已过期则返回 null（调用方应回退到固定熔断超时）。
 */
export function extractRateLimitResetAt(
  message?: string | null,
  retryAfter?: string | null
): number | null {
  // 1. Retry-After（秒数或 HTTP-date）
  if (typeof retryAfter === 'string' && retryAfter.trim().length > 0) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) {
      const asSeconds = Number(trimmed);
      if (asSeconds > 0) {
        return Date.now() + asSeconds * 1000;
      }
    } else {
      const asDate = Date.parse(trimmed);
      if (!Number.isNaN(asDate)) return asDate;
    }
  }

  // 2. 消息正文里的 "reset at ..."
  if (typeof message === 'string' && message.length > 0) {
    return parseResetDateFromMessage(message);
  }

  return null;
}
