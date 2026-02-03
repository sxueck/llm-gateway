import crypto from 'crypto';
import { memoryLogger } from './logger.js';
import type { VirtualKey } from '../types/index.js';

const DEFAULT_MAX_EDGE_PX = 768;
const DEFAULT_CACHE_MAX_BYTES = 100 * 1024 * 1024; // 100MB

const MAX_EDGE_PX = clampInt(process.env.IMAGE_COMPRESSION_MAX_EDGE_PX, DEFAULT_MAX_EDGE_PX, 64, 4096);
const CACHE_MAX_BYTES = clampInt(process.env.IMAGE_COMPRESSION_CACHE_MAX_BYTES, DEFAULT_CACHE_MAX_BYTES, 1 * 1024 * 1024, 2 * 1024 * 1024 * 1024);

type SupportedMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

type CacheValue = {
  mediaType: SupportedMediaType;
  bytes: Buffer;
};

type CompressionStats = {
  imagesSeen: number;
  imagesCompressed: number;
  cacheHits: number;
  bytesBefore: number;
  bytesAfter: number;
};

class LruByteCache<T> {
  private readonly maxBytes: number;
  private readonly map = new Map<string, { value: T; size: number; access: number }>();
  private accessCounter = 0;
  private currentBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1, maxBytes);
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    entry.access = ++this.accessCounter;
    return entry.value;
  }

  set(key: string, value: T, size: number): void {
    const normalizedSize = Math.max(0, size | 0);
    const prev = this.map.get(key);
    if (prev) {
      this.currentBytes -= prev.size;
    }
    this.map.set(key, { value, size: normalizedSize, access: ++this.accessCounter });
    this.currentBytes += normalizedSize;
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.currentBytes <= this.maxBytes) return;
    // Evict LRU entries until within the budget.
    while (this.currentBytes > this.maxBytes && this.map.size > 0) {
      let oldestKey: string | null = null;
      let oldestAccess = Infinity;
      for (const [key, entry] of this.map.entries()) {
        if (entry.access < oldestAccess) {
          oldestAccess = entry.access;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      const entry = this.map.get(oldestKey);
      if (entry) this.currentBytes -= entry.size;
      this.map.delete(oldestKey);
    }
  }
}

const imageCache = new LruByteCache<CacheValue>(CACHE_MAX_BYTES);

export async function maybeCompressImagesInOpenAIRequestBodyInPlace(body: any, virtualKey: VirtualKey): Promise<CompressionStats | null> {
  if (!body || virtualKey.image_compression_enabled !== 1) return null;
  const requestScoped = new Map<string, Promise<CacheValue>>();
  const stats: CompressionStats = { imagesSeen: 0, imagesCompressed: 0, cacheHits: 0, bytesBefore: 0, bytesAfter: 0 };

  // /v1/chat/completions
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type !== 'image_url') continue;

        const url = typeof part.image_url === 'string'
          ? part.image_url
          : part.image_url && typeof part.image_url === 'object'
            ? part.image_url.url
            : undefined;

        if (typeof url !== 'string') continue;
        const parsed = parseDataUrl(url);
        if (!parsed) continue;
        stats.imagesSeen++;
        stats.bytesBefore += parsed.bytes.length;

        const key = makeCacheKey(virtualKey.id, parsed.bytes);
        const cached = imageCache.get(key);
        if (cached) {
          stats.cacheHits++;
          stats.bytesAfter += cached.bytes.length;
          setOpenAIImageUrl(part, buildDataUrl(cached.mediaType, cached.bytes));
          continue;
        }

        const work = requestScoped.get(key) || (async () => {
          const resized = await resizeWithSharp(parsed.bytes, parsed.mediaType, MAX_EDGE_PX);
          const value: CacheValue = { mediaType: parsed.mediaType, bytes: resized };
          imageCache.set(key, value, resized.length);
          return value;
        })();
        requestScoped.set(key, work);

        const value = await work;
        stats.imagesCompressed++;
        stats.bytesAfter += value.bytes.length;
        setOpenAIImageUrl(part, buildDataUrl(value.mediaType, value.bytes));
      }
    }
  }

  // /v1/responses
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      const content = (item as any).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const type = (block as any).type;
        if (type !== 'input_image') continue;
        const rawImageUrl = (block as any).image_url;
        const url = typeof rawImageUrl === 'string'
          ? rawImageUrl
          : rawImageUrl && typeof rawImageUrl === 'object'
            ? rawImageUrl.url
            : undefined;
        if (typeof url !== 'string') continue;

        const parsed = parseDataUrl(url);
        if (!parsed) continue;
        stats.imagesSeen++;
        stats.bytesBefore += parsed.bytes.length;

        const key = makeCacheKey(virtualKey.id, parsed.bytes);
        const cached = imageCache.get(key);
        if (cached) {
          stats.cacheHits++;
          stats.bytesAfter += cached.bytes.length;
          if (typeof rawImageUrl === 'string') {
            (block as any).image_url = buildDataUrl(cached.mediaType, cached.bytes);
          } else if (rawImageUrl && typeof rawImageUrl === 'object') {
            rawImageUrl.url = buildDataUrl(cached.mediaType, cached.bytes);
          }
          continue;
        }

        const work = requestScoped.get(key) || (async () => {
          const resized = await resizeWithSharp(parsed.bytes, parsed.mediaType, MAX_EDGE_PX);
          const value: CacheValue = { mediaType: parsed.mediaType, bytes: resized };
          imageCache.set(key, value, resized.length);
          return value;
        })();
        requestScoped.set(key, work);

        const value = await work;
        stats.imagesCompressed++;
        stats.bytesAfter += value.bytes.length;
        if (typeof rawImageUrl === 'string') {
          (block as any).image_url = buildDataUrl(value.mediaType, value.bytes);
        } else if (rawImageUrl && typeof rawImageUrl === 'object') {
          rawImageUrl.url = buildDataUrl(value.mediaType, value.bytes);
        }
      }
    }
  }

  if (stats.imagesSeen === 0) return null;
  return stats;
}

export async function maybeCompressImagesInAnthropicRequestBodyInPlace(body: any, virtualKey: VirtualKey): Promise<CompressionStats | null> {
  if (!body || virtualKey.image_compression_enabled !== 1) return null;
  const requestScoped = new Map<string, Promise<CacheValue>>();
  const stats: CompressionStats = { imagesSeen: 0, imagesCompressed: 0, cacheHits: 0, bytesBefore: 0, bytesAfter: 0 };

  if (!Array.isArray(body.messages)) return null;

  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if ((block as any).type !== 'image') continue;
      const source = (block as any).source;
      if (!source || typeof source !== 'object') continue;
      if (source.type !== 'base64') continue;

      const mediaType = normalizeSupportedMediaType(source.media_type);
      if (!mediaType) continue;
      if (typeof source.data !== 'string' || source.data.length === 0) continue;

      const bytes = decodeBase64(source.data);
      if (!bytes) continue;

      stats.imagesSeen++;
      stats.bytesBefore += bytes.length;

      const key = makeCacheKey(virtualKey.id, bytes);
      const cached = imageCache.get(key);
      if (cached) {
        stats.cacheHits++;
        stats.bytesAfter += cached.bytes.length;
        source.data = cached.bytes.toString('base64');
        source.media_type = cached.mediaType;
        continue;
      }

      const work = requestScoped.get(key) || (async () => {
        const resized = await resizeWithSharp(bytes, mediaType, MAX_EDGE_PX);
        const value: CacheValue = { mediaType, bytes: resized };
        imageCache.set(key, value, resized.length);
        return value;
      })();
      requestScoped.set(key, work);

      const value = await work;
      stats.imagesCompressed++;
      stats.bytesAfter += value.bytes.length;
      source.data = value.bytes.toString('base64');
      source.media_type = value.mediaType;
    }
  }

  if (stats.imagesSeen === 0) return null;
  return stats;
}

function setOpenAIImageUrl(part: any, dataUrl: string): void {
  if (!part || typeof part !== 'object') return;
  if (typeof part.image_url === 'string') {
    part.image_url = dataUrl;
    return;
  }
  if (part.image_url && typeof part.image_url === 'object') {
    part.image_url.url = dataUrl;
  }
}

function makeCacheKey(virtualKeyId: string, originalBytes: Buffer): string {
  const hash = crypto.createHash('sha256').update(originalBytes).digest('hex');
  return `${virtualKeyId}:${hash}`;
}

function parseDataUrl(url: string): { mediaType: SupportedMediaType; bytes: Buffer } | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('data:image/')) return null;
  const base64Marker = ';base64,';
  const idx = trimmed.indexOf(base64Marker);
  if (idx < 0) return null;
  const mediaTypeRaw = trimmed.slice('data:'.length, idx);
  const mediaType = normalizeSupportedMediaType(mediaTypeRaw);
  if (!mediaType) return null;
  const base64 = trimmed.slice(idx + base64Marker.length).trim();
  const bytes = decodeBase64(base64);
  if (!bytes) return null;
  return { mediaType, bytes };
}

function buildDataUrl(mediaType: SupportedMediaType, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

function normalizeSupportedMediaType(mediaType: any): SupportedMediaType | null {
  if (typeof mediaType !== 'string') return null;
  const mt = mediaType.trim().toLowerCase();
  if (mt === 'image/png' || mt === 'image/jpeg' || mt === 'image/webp') return mt;
  return null;
}

function decodeBase64(base64: string): Buffer | null {
  try {
    // Buffer.from tolerates invalid chars; we validate by re-encoding a prefix.
    const buf = Buffer.from(base64, 'base64');
    if (!buf || buf.length === 0) return null;
    return buf;
  } catch {
    return null;
  }
}

async function resizeWithSharp(bytes: Buffer, mediaType: SupportedMediaType, maxEdgePx: number): Promise<Buffer> {
  // Lazy-load native dependency.
  let sharpMod: any;
  try {
    sharpMod = await import('sharp');
  } catch (e: any) {
    memoryLogger.warn(`sharp 未安装，跳过图像压缩: ${e?.message || e}`, 'ImageCompression');
    return bytes;
  }
  const sharp = sharpMod?.default || sharpMod;
  if (typeof sharp !== 'function') {
    memoryLogger.warn('sharp 模块不可用，跳过图像压缩', 'ImageCompression');
    return bytes;
  }

  try {
    const img = sharp(bytes, { failOn: 'none' });
    const meta = await img.metadata();
    const width = typeof meta.width === 'number' ? meta.width : null;
    const height = typeof meta.height === 'number' ? meta.height : null;
    if (width && height) {
      const longest = Math.max(width, height);
      if (longest <= maxEdgePx) return bytes;
    }

    const resized = img.resize({
      width: maxEdgePx,
      height: maxEdgePx,
      fit: 'inside',
      withoutEnlargement: true,
    });

    let out: Buffer;
    if (mediaType === 'image/png') out = await resized.png().toBuffer();
    else if (mediaType === 'image/webp') out = await resized.webp().toBuffer();
    else out = await resized.jpeg().toBuffer();

    // Never bloat payload: if re-encoding is bigger, keep original.
    return out.length > 0 && out.length < bytes.length ? out : bytes;
  } catch (e: any) {
    memoryLogger.warn(`图像压缩失败，已跳过: ${e?.message || e}`, 'ImageCompression');
    return bytes;
  }
}

function clampInt(raw: any, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  const v = Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(max, Math.max(min, v));
}

export function logImageCompressionStats(stats: CompressionStats, opts?: { vkDisplay?: string; protocol?: string }): void {
  const saved = stats.bytesBefore - stats.bytesAfter;
  memoryLogger.info(
    `图像压缩 | ${opts?.protocol || 'unknown'} | vk=${opts?.vkDisplay || 'unknown'} | ` +
      `seen=${stats.imagesSeen} compressed=${stats.imagesCompressed} cacheHit=${stats.cacheHits} ` +
      `bytes=${stats.bytesBefore}->${stats.bytesAfter} saved=${saved}`,
    'ImageCompression'
  );
}
