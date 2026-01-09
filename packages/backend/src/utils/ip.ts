import { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { memoryLogger } from '../services/logger.js';
import { appConfig } from '../config/index.js';

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
	// Dashboard 需求：属地展示精确到“国家 · 省份”即可，例如 "China · Guangdong"
	// 优先使用 国家 + 省份；如果没有省份但有城市，则退化为 国家 + 城市；否则使用单一可用字段
	const { country, province, city } = parts;
	const hasCountry = !!country;
	const hasProvince = !!province;
	const hasCity = !!city;

	if (hasCountry && hasProvince) {
		return `${country} · ${province}`;
	}

	if (hasCountry && !hasProvince && hasCity) {
		return `${country} · ${city}`;
	}

	const segments = [country, province || city].filter(Boolean) as string[];
	return segments.length > 0 ? segments.join(' · ') : '未知';
}

async function fetchGeoFromIpApiCom(ip: string) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    // ip-api.com free endpoint is HTTP only
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,isp,org,as,lat,lon`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data.status !== 'success') return null;

    return {
      country: data.country,
      region: data.regionName,
      city: data.city,
      isp: data.isp,
      org: data.org,
      asn: data.as ? data.as.split(' ')[0] : undefined,
      latitude: data.lat,
      longitude: data.lon,
    };
  } catch {
    return null;
  }
}

/**
 * 获取 IP 的地理位置信息 (仅使用 ip-api.com)
 */
export async function getGeoInfo(ip: string | null | undefined): Promise<GeoInfo | null> {
  if (!ip) {
    return null;
  }

  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp || isPrivateIp(normalizedIp)) {
    return null;
  }

  // 如果配置关闭了外部 GeoIP 查询，直接返回 null，避免对第三方服务发起请求
  if (!appConfig.geoIpEnabled) {
    return null;
  }

  const cached = geoCache.get(normalizedIp);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.info;
  }

  try {
    // 仅使用 ip-api.com 作为查询源
    const result = await fetchGeoFromIpApiCom(normalizedIp);
    
    if (result) {
      const info: GeoInfo = {
        ip: normalizedIp,
        country: result.country,
        province: result.region,
        city: result.city,
        isp: result.isp,
        ispZh: result.isp,
        locationZh: buildLocationLabel({
          country: result.country,
          province: result.region,
          city: result.city
        }),
        asn: result.asn,
        asOrganization: result.org,
        latitude: result.latitude,
        longitude: result.longitude,
      };

      geoCache.set(normalizedIp, {
        info,
        expiresAt: Date.now() + GEO_CACHE_TTL,
      });
      return info;
    }

    return null;
  } catch (error: any) {
    memoryLogger.warn(`获取 IP(${normalizedIp}) 位置信息失败: ${error?.message || error}`, 'GeoIP');
    return null;
  }
}
