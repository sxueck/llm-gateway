import geoip from 'geoip-lite';
import { FastifyRequest } from 'fastify';

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
  status: string;
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
  lat: number;
  lon: number;
  timezone: string;
  eu?: string;
}

/**
 * 获取 IP 的地理位置信息 (使用 geoip-lite 本地库)
 */
export function getGeoInfo(ip: string | null | undefined): GeoInfo | null {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === 'localhost' || ip === '::1') {
    return null;
  }

  try {
    const geo = geoip.lookup(ip);
    if (geo) {
      return {
        status: 'success',
        country: geo.country, // 2位国家代码
        countryCode: geo.country,
        region: geo.region,
        regionName: geo.region, // geoip-lite 不直接提供全名，这里暂用代码
        city: geo.city || '',
        lat: geo.ll[0],
        lon: geo.ll[1],
        timezone: geo.timezone,
        eu: (geo as any).eu, // geoip-lite 可能返回 eu 字段 ('1' 或 '0')
      };
    }
    return null;
  } catch (e) {
    // 忽略查找失败的错误，直接返回 null
    return null;
  }
}
