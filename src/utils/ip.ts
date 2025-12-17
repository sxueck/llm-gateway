import IP2Region from 'ip2region';
import { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { memoryLogger } from '../services/logger.js';

let ipSearcher: IP2Region | null = null;

try {
  ipSearcher = new IP2Region();
} catch (error: any) {
  memoryLogger.error(`初始化 IP2Region 失败: ${error?.message || error}`, 'GeoIP');
}

const GEO_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const geoCache = new Map<string, { expiresAt: number; info: GeoInfo }>();

/**
 * 从 Fastify 请求中提取客户端 IP
 */
export function extractIp(request: FastifyRequest): string {
  const ipHeader = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.ip || 'unknown';
  if (Array.isArray(ipHeader)) {
    return ipHeader[0];
  }
  // 如果是 x-forwarded-for，可能包含多个 IP，取第一个
  if (typeof ipHeader === 'string' && ipHeader.includes(',')) {
    return ipHeader.split(',')[0].trim();
  }
  return ipHeader;
}

export interface GeoInfo {
  ip: string;
  country?: string;
  province?: string;
  city?: string;
  isp?: string;
  ispZh?: string;
  locationZh: string;
  asn?: string;
  asOrganization?: string;
  latitude?: number;
  longitude?: number;
}

const INTERNAL_IPV4_PREFIXES = ['127.', '10.', '192.168.', '169.254.'];

export function normalizeIp(ip: string): string {
  if (!ip) return '';
  let normalized = ip.trim();
  if (normalized.includes(',')) {
    normalized = normalized.split(',')[0].trim();
  }
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }
  if (normalized === 'localhost') return '127.0.0.1';
  return normalized;
}

function isPrivateIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return true;
  if (INTERNAL_IPV4_PREFIXES.some(prefix => ip.startsWith(prefix))) {
    return true;
  }
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    if (!Number.isNaN(second) && second >= 16 && second <= 31) {
      return true;
    }
  }
  const ipType = isIP(ip);
  if (ipType === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return false;
}

function buildLocationLabel(parts: { country?: string; province?: string; city?: string }) {
  const segments = [parts.country, parts.province, parts.city].filter(Boolean);
  return segments.length > 0 ? segments.join(' · ') : '未知';
}

async function fetchAsnMetadata(ip: string) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'llm-gateway-ip-lookup',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return null;
    }
    const data: any = await res.json();
    if (!data || data.error) {
      return null;
    }
    const asn = typeof data.asn === 'string'
      ? data.asn
      : (typeof data.asn === 'number' ? `AS${data.asn}` : undefined);
    return {
      asn,
      organization: data.org || data.org_name || data.company || undefined,
      latitude: typeof data.latitude === 'number' ? data.latitude : undefined,
      longitude: typeof data.longitude === 'number' ? data.longitude : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 获取 IP 的地理位置信息 (使用 ip2region + ipapi ASN)
 */
export async function getGeoInfo(ip: string | null | undefined): Promise<GeoInfo | null> {
  if (!ip) {
    return null;
  }

  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp || isPrivateIp(normalizedIp) || !ipSearcher) {
    return null;
  }

  const cached = geoCache.get(normalizedIp);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.info;
  }

  try {
    const result = ipSearcher.search(normalizedIp);
    if (!result) {
      return null;
    }

    const info: GeoInfo = {
      ip: normalizedIp,
      country: result.country || undefined,
      province: result.province || undefined,
      city: result.city || undefined,
      isp: result.isp || undefined,
      ispZh: result.isp || undefined,
      locationZh: buildLocationLabel(result),
    };

    const asnMeta = await fetchAsnMetadata(normalizedIp);
    if (asnMeta) {
      info.asn = asnMeta.asn;
      info.asOrganization = asnMeta.organization;
      info.latitude = asnMeta.latitude;
      info.longitude = asnMeta.longitude;
    }

    geoCache.set(normalizedIp, {
      info,
      expiresAt: Date.now() + GEO_CACHE_TTL,
    });

    return info;
  } catch (error: any) {
    memoryLogger.warn(`获取 IP(${normalizedIp}) 位置信息失败: ${error?.message || error}`, 'GeoIP');
    return null;
  }
}
