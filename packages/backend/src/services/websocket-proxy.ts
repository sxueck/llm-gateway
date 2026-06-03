export function deriveWebSocketUrl(httpBaseUrl: string, path: string): string {
  let url = httpBaseUrl.trim().replace(/\/+$/, '');

  if (url.startsWith('https://')) {
    url = 'wss://' + url.slice(8);
  } else if (url.startsWith('http://')) {
    url = 'ws://' + url.slice(7);
  } else if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
    url = 'wss://' + url;
  }

  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  return url + normalizedPath;
}
