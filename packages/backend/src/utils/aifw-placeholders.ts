export type AifwPlaceholdersMap = Record<string, string>;

function tryParseJsonObject(text: string): AifwPlaceholdersMap | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const map: AifwPlaceholdersMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string') {
        map[k] = v;
      }
    }
    return map;
  } catch {
    return null;
  }
}

function padIndex(index: string, width = 8): string {
  if (!index) return index;
  // Keep purely numeric indices only.
  if (!/^[0-9]+$/.test(index)) return index;
  if (index.length >= width) return index;
  return index.padStart(width, '0');
}

function stripLeadingZeros(index: string): string {
  if (!index) return index;
  if (!/^[0-9]+$/.test(index)) return index;
  // Preserve a single 0 if the index is all zeros.
  const stripped = index.replace(/^0+/, '');
  return stripped.length === 0 ? '0' : stripped;
}

function expandPlaceholderKeyVariants(key: string): string[] {
  // Accept both OneAIFW documented format:
  //   __PII_EMAIL_ADDRESS_00000001__
  // And common model-corrupted variants:
  //   __PII_EMAIL_ADDRESS_1__
  const m = /^__PII_([A-Z0-9_]+)_([0-9]+)__$/.exec(key);
  if (!m) return [key];

  const type = m[1];
  const rawIndex = m[2];
  const stripped = stripLeadingZeros(rawIndex);
  const padded8 = padIndex(stripped, 8);

  const out = new Set<string>();
  out.add(key);
  out.add(`__PII_${type}_${stripped}__`);
  out.add(`__PII_${type}_${padded8}__`);
  return Array.from(out);
}

function normalizePlaceholdersMap(map: AifwPlaceholdersMap): AifwPlaceholdersMap {
  const out: AifwPlaceholdersMap = { ...map };
  for (const [k, v] of Object.entries(map || {})) {
    for (const variant of expandPlaceholderKeyVariants(k)) {
      // Do not overwrite an existing mapping; keep the first seen value.
      if (out[variant] === undefined) out[variant] = v;
    }
  }
  return out;
}

/**
 * Heuristic mapping from Type ID to PII Type String.
 * Inferred from typical PII handling and user reports.
 * Used when binary maskMeta format is detected.
 */
const TYPE_ID_MAPPING: Record<number, string[]> = {
  1: ['EMAIL_ADDRESS', 'EMAIL'],
  2: ['PHONE_NUMBER', 'PHONE'],
  3: ['PERSON_NAME', 'USERNAME', 'NAME'],
  4: ['ORGANIZATION', 'COMPANY'],
  5: ['LOCATION', 'ADDRESS'],
  6: ['BANK_NUMBER', 'BANK_CARD'],
  7: ['PAYMENT', 'CREDIT_CARD'],
  8: ['VERIFICATION_CODE'],
  9: ['PASSWORD'],
  10: ['RANDOM_SEED', 'KEY'],
  11: ['PRIVATE_KEY'],
  12: ['URL', 'LINK'],
};

function decodeBinaryMaskMeta(buf: Buffer): AifwPlaceholdersMap | null {
  try {
    const map: AifwPlaceholdersMap = {};
    let offset = 4; // Skip Header/TotalLen (4 bytes)

    while (offset < buf.length) {
      if (offset + 4 > buf.length) break;
      const valueLen = buf.readInt32LE(offset);
      offset += 4;

      if (valueLen < 0 || valueLen > buf.length - offset) {
        // Invalid length, maybe not this format
        return null;
      }

      const value = buf.toString('utf8', offset, offset + valueLen);
      offset += valueLen;

      if (offset + 24 > buf.length) break; // Need 24 bytes for Item Header

      const typeId = buf.readInt32LE(offset);
      offset += 4;
      const index = buf.readInt32LE(offset);
      offset += 4;
      // Skip StartOffset (4), Length (4), Confidence (4), Padding (4)
      offset += 16;

      const typeNames = TYPE_ID_MAPPING[typeId] || [`UNKNOWN_TYPE_${typeId}`];
      
      // Generate potential keys
      for (const typeName of typeNames) {
        // Generate both padded and non-padded indices.
        const idx = String(index);
        const stripped = stripLeadingZeros(idx);
        const padded8 = padIndex(stripped, 8);
        map[`__PII_${typeName}_${stripped}__`] = value;
        map[`__PII_${typeName}_${padded8}__`] = value;
      }
      
      // Add a generic fallback key just in case we can't guess the type name
      const idx = String(index);
      const stripped = stripLeadingZeros(idx);
      const padded8 = padIndex(stripped, 8);
      map[`__PII_${typeId}_${stripped}__`] = value;
      map[`__PII_${typeId}_${padded8}__`] = value;
    }
    
    return Object.keys(map).length > 0 ? normalizePlaceholdersMap(map) : null;
  } catch (e) {
    return null;
  }
}

export function decodeAifwMaskMeta(maskMeta: string): AifwPlaceholdersMap | null {
  if (!maskMeta || typeof maskMeta !== 'string') return null;
  try {
    // Some OneAIFW deployments return JSON directly (not base64).
    // Prefer that because it's unambiguous and enables streaming restoration.
    const directJsonMap = tryParseJsonObject(maskMeta);
    if (directJsonMap) return normalizePlaceholdersMap(directJsonMap);

    const decoded = Buffer.from(maskMeta, 'base64');

    // 1. Try JSON first (Standard): base64(utf8(JSON(placeholdersMap)))
    const jsonMap = tryParseJsonObject(decoded.toString('utf8'));
    if (jsonMap) return normalizePlaceholdersMap(jsonMap);

    // 2. Try Binary Format (Fallback)
    // Heuristic: Check if starts with length? Or just try parse.
    // The user blob started with 0x30 (48).
    const binaryMap = decodeBinaryMaskMeta(decoded);
    if (binaryMap) {
      return binaryMap;
    }
    
    // Log warning if neither JSON nor Binary decoder worked, but content exists
    if (decoded.length > 0) {
      // It might be a new format or opaque token. 
      // We should return an empty map but NOT null, so that the context keeps the maskMeta.
      // However, the caller relies on the map for local restoration.
      // If we return null, the caller might think "no masking happened".
    }

    return null;
  } catch {
    return null;
  }
}

function tryDecodeJsonMaskMeta(maskMeta: string): AifwPlaceholdersMap | null {
  if (!maskMeta || typeof maskMeta !== 'string') return null;
  try {
    const decoded = Buffer.from(maskMeta, 'base64');
    const json = decoded.toString('utf8');
    if (!json.trim().startsWith('{')) return null;
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && typeof value === 'string') {
        map[key] = value;
      }
    }

    return Object.keys(map).length > 0 ? map : {};
  } catch {
    return null;
  }
}

function looksLikeBinaryMaskMeta(buf: Buffer): boolean {
  // Observed format (from uvicorn OneAIFW):
  //   [totalLen:int32LE][records...]
  // where totalLen equals the buffer length.
  if (!buf || buf.length < 4) return false;
  try {
    return buf.readInt32LE(0) === buf.length;
  } catch {
    return false;
  }
}

/**
 * Merge multiple OneAIFW `maskMeta` values into a single `maskMeta`.
 *
 * Why: our gateway masks multiple string fields in a request, but restores
 * the upstream response with a single `maskMeta`.
 *
 * Supports:
 * - JSON format: base64(utf8(JSON(placeholdersMap)))
 * - Binary format: base64(binary_records) with a 4-byte total length header.
 *
 * If formats are mixed/unknown, falls back to the first non-empty meta.
 */
export function mergeAifwMaskMetas(maskMetas: string[]): string {
  const metas = (maskMetas || []).filter((m) => typeof m === 'string' && m.trim());
  if (metas.length === 0) return '';
  if (metas.length === 1) return metas[0];

  // 1) Prefer JSON merge when all metas are JSON maps.
  const merged: Record<string, string> = {};
  let allJson = true;
  for (const meta of metas) {
    const map = tryDecodeJsonMaskMeta(meta);
    if (map == null) {
      allJson = false;
      break;
    }
    Object.assign(merged, map);
  }
  if (allJson) {
    return Buffer.from(JSON.stringify(merged)).toString('base64');
  }

  // 2) Binary merge: concatenate record bodies and rewrite the total length.
  try {
    const bufs = metas.map((m) => Buffer.from(m, 'base64'));
    if (bufs.every((b) => looksLikeBinaryMaskMeta(b))) {
      const bodies = bufs.map((b) => b.subarray(4));
      const bodyLen = bodies.reduce((sum, b) => sum + b.length, 0);
      const totalLen = 4 + bodyLen;
      const header = Buffer.allocUnsafe(4);
      header.writeInt32LE(totalLen, 0);
      return Buffer.concat([header, ...bodies], totalLen).toString('base64');
    }
  } catch {
    // fall through
  }

  // Unknown/opaque: best effort.
  return metas[0];
}

// IMPORTANT: Keep the regex limits and streaming buffer limits consistent.
// Placeholder format: "__PII_" + BODY + "__"
const PLACEHOLDER_BODY_MIN_LEN = 3;
const PLACEHOLDER_BODY_MAX_LEN = 160;
const PLACEHOLDER_PREFIX = '__PII_';
const PLACEHOLDER_SUFFIX = '__';
const PLACEHOLDER_TOTAL_MAX_LEN = PLACEHOLDER_PREFIX.length + PLACEHOLDER_BODY_MAX_LEN + PLACEHOLDER_SUFFIX.length;

const PLACEHOLDER_REGEX = new RegExp(
  `${PLACEHOLDER_PREFIX.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[A-Z0-9_]{${PLACEHOLDER_BODY_MIN_LEN},${PLACEHOLDER_BODY_MAX_LEN}}${PLACEHOLDER_SUFFIX}`,
  'g'
);

const PLACEHOLDER_REGEX_NO_GLOBAL = new RegExp(PLACEHOLDER_REGEX.source);

export function restorePlaceholdersInText(text: string, placeholdersMap: AifwPlaceholdersMap): string {
  if (!text || typeof text !== 'string') return text;
  if (!placeholdersMap || typeof placeholdersMap !== 'object') return text;

  return text.replace(PLACEHOLDER_REGEX, (match) => {
    const replacement = placeholdersMap[match];
    return typeof replacement === 'string' ? replacement : match;
  });
}

export function restorePlaceholdersInObjectInPlace(obj: any, placeholdersMap: AifwPlaceholdersMap): void {
  if (!obj || typeof obj !== 'object') return;

  // Defensive traversal:
  // - Avoid stack overflows on deep objects
  // - Avoid infinite loops on cyclic graphs
  // - Be resilient to malformed upstream responses
  const seen = typeof WeakSet !== 'undefined' ? new WeakSet<object>() : null;
  const stack: any[] = [obj];
  let visitedNodes = 0;
  const MAX_NODES = 50_000;

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(cur)) {
      continue;
    }

    if (cur instanceof Date) {
      continue;
    }

    if (seen) {
      if (seen.has(cur)) continue;
      seen.add(cur);
    }

    visitedNodes++;
    if (visitedNodes > MAX_NODES) {
      // Prevent pathological payloads from consuming too much time/memory.
      return;
    }

    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) {
        const v = cur[i];
        if (typeof v === 'string') {
          cur[i] = restorePlaceholdersInText(v, placeholdersMap);
        } else if (v && typeof v === 'object') {
          stack.push(v);
        }
      }
      continue;
    }

    for (const key of Object.keys(cur)) {
      const v = cur[key];
      if (typeof v === 'string') {
        cur[key] = restorePlaceholdersInText(v, placeholdersMap);
      } else if (v && typeof v === 'object') {
        stack.push(v);
      }
    }
  }
}

export function getMaxPlaceholderLength(placeholdersMap: AifwPlaceholdersMap): number {
  let maxLen = 0;
  for (const key of Object.keys(placeholdersMap || {})) {
    if (typeof key === 'string' && key.length > maxLen) {
      maxLen = key.length;
    }
  }
  return maxLen;
}

export class AifwStreamRestorer {
  private pendingByKey = new Map<string, string>();
  private readonly placeholdersMap: AifwPlaceholdersMap;
  private readonly maxPlaceholderLen: number;

  constructor(placeholdersMap: AifwPlaceholdersMap) {
    this.placeholdersMap = placeholdersMap;
    // Use the regex maximum as a lower bound so we don't cut valid placeholders
    // when the placeholdersMap is incomplete or malformed.
    this.maxPlaceholderLen = Math.max(PLACEHOLDER_TOTAL_MAX_LEN, 8, getMaxPlaceholderLength(placeholdersMap));
  }

  private computeNextPending(buffer: string): { toProcess: string; pending: string } {
    if (!buffer) return { toProcess: '', pending: '' };

    // Fast path: if there's no marker, keep at most a partial "__PII_" prefix.
    if (!buffer.includes('__')) {
      const maxPrefixKeep = PLACEHOLDER_PREFIX.length - 1;
      const keep = Math.min(maxPrefixKeep, buffer.length);
      return {
        toProcess: buffer.slice(0, buffer.length - keep),
        pending: buffer.slice(buffer.length - keep),
      };
    }

    // Look for the last start marker within the last maxPlaceholderLen window.
    const windowStart = Math.max(0, buffer.length - (this.maxPlaceholderLen - 1));
    const window = buffer.slice(windowStart);
    const markerPosInWindow = window.lastIndexOf(PLACEHOLDER_PREFIX);
    if (markerPosInWindow >= 0) {
      const markerPos = windowStart + markerPosInWindow;
      const candidate = buffer.slice(markerPos);

      // If it's already a full placeholder token (even if unknown to map), don't buffer it.
      if (candidate.endsWith(PLACEHOLDER_SUFFIX) && PLACEHOLDER_REGEX_NO_GLOBAL.test(candidate)) {
        return { toProcess: buffer, pending: '' };
      }

      return {
        toProcess: buffer.slice(0, markerPos),
        pending: buffer.slice(markerPos),
      };
    }

    // Otherwise, just keep a suffix window.
    const keep = Math.min(this.maxPlaceholderLen - 1, buffer.length);
    return {
      toProcess: buffer.slice(0, buffer.length - keep),
      pending: buffer.slice(buffer.length - keep),
    };
  }

  process(key: string, fragment: string): string {
    if (typeof fragment !== 'string' || fragment.length === 0) {
      return fragment;
    }

    const pending = this.pendingByKey.get(key) || '';
    let combined = pending + fragment;

    // Try to restore ANY full placeholders in the combined buffer immediately
    combined = restorePlaceholdersInText(combined, this.placeholdersMap);

    const { toProcess, pending: nextPending } = this.computeNextPending(combined);
    this.pendingByKey.set(key, nextPending);
    return toProcess;
  }

  flush(key: string): string {
    const pending = this.pendingByKey.get(key) || '';
    this.pendingByKey.set(key, '');
    return restorePlaceholdersInText(pending, this.placeholdersMap);
  }
}
