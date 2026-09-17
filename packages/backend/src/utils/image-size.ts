const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 24 bytes cover signature + chunk header + IHDR width/height; 24 bytes = 32 base64 chars.
const PNG_HEADER_B64_CHARS = 32;
const PNG_HEADER_BYTES = 24;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface SizeMismatch {
  requested: string;
  actual: string;
}

// Decodes only the leading IHDR bytes of a base64 PNG — never the full payload,
// which can be several MB.
export function parsePngDimensions(base64: string): ImageDimensions | null {
  if (typeof base64 !== 'string' || base64.length < PNG_HEADER_B64_CHARS) {
    return null;
  }
  const header = Buffer.from(base64.slice(0, PNG_HEADER_B64_CHARS), 'base64');
  if (header.length < PNG_HEADER_BYTES) return null;
  if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (header.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

const SIZE_PATTERN = /^\d{1,5}x\d{1,5}$/;

// Some upstream channels silently drop the `size` parameter and return images
// at a model-chosen resolution, so verify the returned PNG's real dimensions
// against the request. Non-WxH sizes ("auto", garbage) and non-PNG payloads
// have no trustworthy contract to compare against and are skipped.
export function detectImageSizeMismatch(requestedSize: unknown, data: unknown): SizeMismatch | null {
  if (typeof requestedSize !== 'string' || !SIZE_PATTERN.test(requestedSize)) {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { b64_json?: unknown } | null | undefined;
  if (!first || typeof first !== 'object' || typeof first.b64_json !== 'string') {
    return null;
  }
  const dims = parsePngDimensions(first.b64_json);
  if (!dims) return null;
  const actual = `${dims.width}x${dims.height}`;
  if (actual === requestedSize) return null;
  return { requested: requestedSize, actual };
}
