import type { FastifyReply } from 'fastify';
import { memoryLogger } from './logger.js';

interface DebugStreamClient {
  reply: FastifyReply;
  heartbeat: NodeJS.Timeout | null;
}

export interface DebugApiEvent {
  type: 'api_request';
  id: string;
  timestamp: number;
  protocol: string;
  method: string;
  path: string;
  stream: boolean;
  success: boolean;
  statusCode?: number;
  fromCache?: boolean;
  virtualKeyId?: string;
  virtualKeyName?: string;
  providerId?: string;
  model?: string;
  durationMs: number;
  requestBody: any;
  responseBody?: any;
  error?: string;
}

/**
 * Developer debug mode service.
 *
 * - State (enabled + expiresAt) is driven by system_config and updated via config routes.
 * - When active, API request logs should not be persisted to DB.
 * - Instead, full request/response payloads are pushed to connected HTTP stream clients.
 */
class DebugModeService {
  private enabled = false;
  private expiresAt = 0;
  private clients = new Set<DebugStreamClient>();
  private eventBuffer: DebugApiEvent[] = [];
  private readonly maxBufferedEvents = 200;

  initFromConfig(enabled: boolean, expiresAt: number | null | undefined) {
    this.enabled = !!enabled;
    this.expiresAt = typeof expiresAt === 'number' && !Number.isNaN(expiresAt) ? expiresAt : 0;

    if (this.isActive()) {
      const expireDate = new Date(this.expiresAt).toLocaleString('zh-CN');
      memoryLogger.warn(`开发者调试模式已启用，将在 ${expireDate} 自动失效`, 'DebugMode');
    }
  }

  setState(enabled: boolean, expiresAt: number) {
    this.enabled = !!enabled;
    this.expiresAt = expiresAt;

    if (this.isActive()) {
      const expireDate = new Date(this.expiresAt).toLocaleString('zh-CN');
      memoryLogger.info(`开发者调试模式已开启，有效期至 ${expireDate}`, 'DebugMode');
    } else {
      memoryLogger.info('开发者调试模式已关闭', 'DebugMode');
      this.eventBuffer = [];
    }

    this.broadcastState();
  }

  isActive(): boolean {
    return this.enabled && this.expiresAt > Date.now();
  }

  getExpiresAt(): number | null {
    return this.expiresAt > Date.now() ? this.expiresAt : null;
  }

  addStreamClient(reply: FastifyReply) {
    const client: DebugStreamClient = {
      reply,
      heartbeat: null,
    };
    client.heartbeat = setInterval(() => {
      this.sendComment(client, 'heartbeat');
    }, 15000);

    this.clients.add(client);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
        client.heartbeat = null;
      }
      this.clients.delete(client);
    };

    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    this.sendStateToClient(client);
    for (const event of this.eventBuffer) {
      this.sendEventToClient(client, event);
    }
  }

  broadcast(event: DebugApiEvent) {
    if (!this.isActive()) return;

    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferedEvents) {
      this.eventBuffer.shift();
    }

    for (const client of this.clients) {
      this.sendEventToClient(client, event);
    }
  }

  private broadcastState() {
    const payload = {
      type: 'debug_state' as const,
      active: this.isActive(),
      expiresAt: this.getExpiresAt(),
    };

    for (const client of this.clients) {
      this.sendPayload(client, payload);
    }
  }

  private sendStateToClient(client: DebugStreamClient) {
    const payload = {
      type: 'debug_state' as const,
      active: this.isActive(),
      expiresAt: this.getExpiresAt(),
    };
    this.sendPayload(client, payload);
  }

  private sendEventToClient(client: DebugStreamClient, event: DebugApiEvent) {
    this.sendPayload(client, event);
  }

  private sendPayload(client: DebugStreamClient, payload: any) {
    try {
      client.reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
        client.heartbeat = null;
      }
      this.clients.delete(client);
      memoryLogger.error(`发送调试流失败: ${(error as Error).message}`, 'DebugMode');
    }
  }

  private sendComment(client: DebugStreamClient, comment: string) {
    try {
      client.reply.raw.write(`: ${comment}\n\n`);
    } catch (_error) {
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
        client.heartbeat = null;
      }
      this.clients.delete(client);
    }
  }
}

export const debugModeService = new DebugModeService();
