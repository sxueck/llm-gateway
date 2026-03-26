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
 * Generate a deterministic masked character based on the original character class
 * and a position/index for variation
 */
function generateMaskedChar(original: CharClass, position: number, type: PiiType, variant = 0): string {
  // Use position and type to create deterministic but varied output
  const seed = position * 31 + type.length + variant * 17;

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

/**
 * Mask a secret while preserving length and character classes
 */
function maskSecret(value: string, variant = 0): string {
  let result = '';

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const classified = classifyChar(char);

    if (classified.isSymbol && '.-_'.includes(char)) {
      // Keep structural separators
      result += char;
    } else {
      result += generateMaskedChar(classified, i, 'secret', variant);
    }
  }

  return result;
}

/**
 * Mask an IP address while preserving format
 */
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

  const threeDigitPool = ['203', '117', '241', '154', '208', '132'];
  const twoDigitPool = ['42', '58', '73', '84', '96', '31'];
  const oneDigitPool = ['6', '7', '8', '4', '5', '3'];

  return parts
    .map((part, idx) => {
      if (!/^\d+$/.test(part)) return part;
      if (part.length === 3) return threeDigitPool[(idx + variant) % threeDigitPool.length];
      if (part.length === 2) {
        if (part.startsWith('0')) {
          return `0${oneDigitPool[(idx + variant) % oneDigitPool.length]}`;
        }
        return twoDigitPool[(idx + variant) % twoDigitPool.length];
      }
      return oneDigitPool[(idx + variant) % oneDigitPool.length];
    })
    .join('.');
}

function maskIpv6(value: string, variant = 0): string {
  // For IPv6, replace with a deterministic fake address in documentation range
  // 2001:db8::/32 is reserved for documentation
  const segments = value.split(':');
  const maskedSegments = segments.map((seg, idx) => {
    if (!seg) return seg; // Keep empty segments for ::
    const masked = seg.split('').map((c, i) => {
        if (/[0-9a-fA-F]/.test(c)) {
          const seed = idx * 16 + i + variant * 11;
          return HEX_LOWER[seed % HEX_LOWER.length];
        }
      return c;
    }).join('');
    return masked;
  });

  return maskedSegments.join(':');
}

/**
 * Mask an email while preserving structure
 */
function maskEmail(value: string, variant = 0): string {
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) {
    return maskSecret(value, variant);
  }

  let result = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '@' || c === '.' || c === '_' || c === '-' || c === '+') {
      result += c;
      continue;
    }

    result += generateMaskedChar(classifyChar(c), i, 'email', variant);
  }

  return result;
}

/**
 * Generate a masked value for the given PII type and original value
 */
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

/**
 * Get or create a masked value for an original value in the context
 * This ensures stable mapping within a request
 */
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

/**
 * Restore original value from masked value
 */
export function restoreOriginalValue(ctx: PiiProtectionContext, masked: string): string {
  return ctx.reverseReplacements.get(masked) ?? masked;
}
