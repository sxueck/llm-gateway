import { isIP } from 'node:net';

export function isPrivateNodeOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number);
    return first === 127 || first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
  }
  return isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd'));
}
