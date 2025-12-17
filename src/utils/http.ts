import type { FastifyRequest } from 'fastify';

export function resolveUserAgent(header: string | string[] | undefined): string {
  if (!header) {
    return '';
  }
  if (Array.isArray(header)) {
    return header[0] || '';
  }
  return header;
}

export function getRequestUserAgent(request: Pick<FastifyRequest, 'headers'>): string {
  return resolveUserAgent(request.headers['user-agent']);
}
