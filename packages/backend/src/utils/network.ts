export function isLocalGateway(gatewayUrl: string): boolean {
  if (!gatewayUrl) {
    return false;
  }
  try {
    const url = new URL(gatewayUrl);
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}