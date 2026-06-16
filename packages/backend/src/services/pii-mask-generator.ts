/**
 * PII Protection - Mask Generator
 *
 * Generates masked values that preserve:
 * - Total length
 * - Character class per position (letter/number/symbol)
 * - Structure (separators, format)
 *
 * Same original value always maps to the same masked value within a request.
 */

import { PiiType, PiiProtectionContext } from './pii-protection-types.js';

// Character sets for masking
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const HEX_LOWER = '0123456789abcdef';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';

interface CharClass {
  isUpper: boolean;
  isLower: boolean;
  isDigit: boolean;
  isHex: boolean;
  isBase64: boolean;
  isUrlSafe: boolean;
  isSymbol: boolean;
  char: string;
}

function classifyChar(char: string): CharClass {
  const code = char.charCodeAt(0);

  // ASCII ranges for character classification (optimized over regex)
  const isUpper = code >= 0x41 && code <= 0x5a; // A-Z
  const isLower = code >= 0x61 && code <= 0x7a; // a-z
  const isDigit = code >= 0x30 && code <= 0x39; // 0-9
  const isHex = isDigit || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46); // 0-9, a-f, A-F
  const isSymbol = !isUpper && !isLower && !isDigit;

  // Base64 chars: A-Z, a-z, 0-9, +, /, =, _, -
  const isBase64 = isUpper || isLower || isDigit || code === 0x2b || code === 0x2f ||
    code === 0x3d || code === 0x5f || code === 0x2d;

  // URL-safe chars: A-Z, a-z, 0-9, ., _, -
  const isUrlSafe = isUpper || isLower || isDigit || code === 0x2e || code === 0x5f || code === 0x2d;

  return { isUpper, isLower, isDigit, isHex, isBase64, isUrlSafe, isSymbol, char };
}

/**
 * Stable, fast content hash (FNV-1a 32-bit) used to seed surrogate generation.
 *
 * Keying surrogates on the *content* of the original value (not just position)
 * makes the masked output a deterministic pure function of the input: the same
 * original always yields the same surrogate, and two different originals of the
 * same shape (e.g. two 5+2 letter emails) get different surrogates instead of
 * colliding. This is essential for upstream prompt / KV-cache stability — in a
 * multi-turn conversation the masked prefix must be byte-identical across
 * requests, regardless of what other PII appears later or in what order.
 */
function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit
  return hash >>> 0;
}

function generateMaskedChar(
  original: CharClass,
  position: number,
  type: PiiType,
  variant = 0,
  valueSeed = 0
): string {
  // Seed on content hash + position + type so surrogates are deterministic per
  // original value and don't collide across same-shaped inputs.
  const seed = (valueSeed + position * 31 + type.length + variant * 17) >>> 0;

  if (original.isDigit) {
    return DIGITS[seed % DIGITS.length];
  }

  if (original.isUpper) {
    return UPPERCASE[seed % UPPERCASE.length];
  }

  if (original.isLower) {
    return LOWERCASE[seed % LOWERCASE.length];
  }

  // For symbols, try to preserve the exact symbol if it's structural
  if (original.isSymbol) {
    // Keep structural characters as-is for format preservation
    const structuralChars = '.@_-:/?=&';
    if (structuralChars.includes(original.char)) {
      return original.char;
    }
    // Otherwise map to a safe symbol
    return URL_SAFE[seed % URL_SAFE.length];
  }

  return 'x';
}

function maskSecret(value: string, variant = 0): string {
  const valueSeed = hashSeed(value);
  let result = '';

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const classified = classifyChar(char);

    if (classified.isSymbol && '.-_'.includes(char)) {
      // Keep structural separators
      result += char;
    } else {
      result += generateMaskedChar(classified, i, 'secret', variant, valueSeed);
    }
  }

  return result;
}

function maskIpAddress(value: string, variant = 0): string {
  if (value.includes(':')) {
    // IPv6
    return maskIpv6(value, variant);
  }
  // IPv4
  return maskIpv4(value, variant);
}

function maskIpv4(value: string, variant = 0): string {
  const parts = value.split('.');
  if (parts.length !== 4) return maskSecret(value, variant);

  const valueSeed = hashSeed(value);
  const threeDigitPool = ['203', '117', '241', '154', '208', '132'];
  const twoDigitPool = ['42', '58', '73', '84', '96', '31'];
  const oneDigitPool = ['6', '7', '8', '4', '5', '3'];
  const pick = (idx: number) => (idx + variant + valueSeed) >>> 0;

  return parts
    .map((part, idx) => {
      if (!/^\d+$/.test(part)) return part;
      if (part.length === 3) return threeDigitPool[pick(idx) % threeDigitPool.length];
      if (part.length === 2) {
        if (part.startsWith('0')) {
          return `0${oneDigitPool[pick(idx) % oneDigitPool.length]}`;
        }
        return twoDigitPool[pick(idx) % twoDigitPool.length];
      }
      return oneDigitPool[pick(idx) % oneDigitPool.length];
    })
    .join('.');
}

function maskIpv6(value: string, variant = 0): string {
  // For IPv6, replace with a deterministic fake address in documentation range
  // 2001:db8::/32 is reserved for documentation
  const valueSeed = hashSeed(value);
  const segments = value.split(':');
  const maskedSegments = segments.map((seg, idx) => {
    if (!seg) return seg; // Keep empty segments for ::
    const masked = seg.split('').map((c, i) => {
        if (/[0-9a-fA-F]/.test(c)) {
          const seed = (valueSeed + idx * 16 + i + variant * 11) >>> 0;
          return HEX_LOWER[seed % HEX_LOWER.length];
        }
      return c;
    }).join('');
    return masked;
  });

  return maskedSegments.join(':');
}

function maskEmail(value: string, variant = 0): string {
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) {
    return maskSecret(value, variant);
  }

  const valueSeed = hashSeed(value);
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '@' || c === '.' || c === '_' || c === '-' || c === '+') {
      result += c;
      continue;
    }

    result += generateMaskedChar(classifyChar(c), i, 'email', variant, valueSeed);
  }

  return result;
}

export function generateMaskedValue(value: string, type: PiiType, variant = 0): string {
  switch (type) {
    case 'secret':
      return maskSecret(value, variant);
    case 'ip':
      return maskIpAddress(value, variant);
    case 'email':
      return maskEmail(value, variant);
    default:
      return maskSecret(value, variant);
  }
}

export function getOrCreateMaskedValue(
  ctx: PiiProtectionContext,
  original: string,
  type: PiiType
): string {
  // Check if we already have a mapping for this original
  const existing = ctx.replacements.get(original);
  if (existing !== undefined) {
    return existing;
  }

  // Generate new masked value
  let variant = 0;
  let masked = generateMaskedValue(original, type, variant);
  while (ctx.reverseReplacements.has(masked) && ctx.reverseReplacements.get(masked) !== original) {
    variant += 1;
    masked = generateMaskedValue(original, type, variant);
  }

  // Store mappings
  ctx.replacements.set(original, masked);
  ctx.reverseReplacements.set(masked, original);
  ctx.restorationCacheVersion += 1;
  ctx.restorationRegex = null;
  ctx.detections.push({
    type,
    original,
    masked,
    position: ctx.counter++,
  });

  return masked;
}

export function restoreOriginalValue(ctx: PiiProtectionContext, masked: string): string {
  return ctx.reverseReplacements.get(masked) ?? masked;
}
