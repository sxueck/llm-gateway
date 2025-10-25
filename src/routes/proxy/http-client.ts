import { FastifyReply } from 'fastify';
import { request as httpRequest, IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface StreamTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamChunks: string[];
}

export function makeHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? httpsRequest : httpRequest;

    const options: any = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      insecureHTTPParser: true,
    };

    if (isHttps) {
      options.rejectUnauthorized = false;
    }

    const req = requestModule(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf-8');
        resolve({
          statusCode: res.statusCode || 500,
          headers: res.headers as Record<string, string | string[]>,
          body: responseBody,
        });
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(body, 'utf-8');
    }

    req.end();
  });
}

export function makeStreamHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  reply: FastifyReply
): Promise<StreamTokenUsage> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? httpsRequest : httpRequest;

    const options: any = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      insecureHTTPParser: true,
    };

    if (isHttps) {
      options.rejectUnauthorized = false;
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let buffer = '';
    const streamChunks: string[] = [];

    const req = requestModule(options, (res: IncomingMessage) => {

      reply.raw.writeHead(res.statusCode || 200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
      });

      res.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString('utf-8');
        buffer += chunkStr;
        streamChunks.push(chunkStr);

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
            try {
              const jsonStr = line.substring(6).trim();
              if (jsonStr) {
                const data = JSON.parse(jsonStr);
                if (data.usage) {
                  promptTokens = data.usage.prompt_tokens || promptTokens;
                  completionTokens = data.usage.completion_tokens || completionTokens;
                  totalTokens = data.usage.total_tokens || totalTokens;
                }
              }
            } catch {
            }
          }
        }

        reply.raw.write(chunk);
      });

      res.on('end', () => {
        reply.raw.end();
        resolve({ promptTokens, completionTokens, totalTokens, streamChunks });
      });

      res.on('error', (err: any) => {
        reject(err);
      });
    });

    req.on('error', (err: any) => {
      reject(err);
    });

    if (body) {
      req.write(body, 'utf-8');
    }

    req.end();
  });
}

