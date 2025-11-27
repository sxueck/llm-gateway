import { memoryLogger } from './logger.js';

interface DebugClient {
  // Using minimal interface here to avoid hard dependency on ws types
  readyState?: number;
  send(data: string): void;
  on?(event: string, listener: (...args: any[]) => void): void;
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
 * - Instead, full request/response payloads are pushed to connected WebSocket clients.
 */
class DebugModeService {
  private enabled = false;
  private expiresAt = 0;
  private clients = new Set<DebugClient>();

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
    }
  }

  isActive(): boolean {
    return this.enabled && this.expiresAt > Date.now();
  }

  getExpiresAt(): number | null {
    return this.expiresAt > Date.now() ? this.expiresAt : null;
  }

  addClient(socket: DebugClient) {
    this.clients.add(socket);

    // Best-effort cleanup when client closes
    if (socket.on) {
      socket.on('close', () => {
        this.clients.delete(socket);
      });
      socket.on('error', () => {
        this.clients.delete(socket);
      });
    }

    // Send initial state so frontend can show countdown without extra HTTP call
    try {
      const payload = JSON.stringify({
        type: 'debug_state',
        active: this.isActive(),
        expiresAt: this.getExpiresAt(),
      });
      socket.send(payload);
    } catch (e) {
      this.clients.delete(socket);
    }
  }

  broadcast(event: DebugApiEvent) {
    if (!this.isActive()) return;

    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      try {
        // 1 means WebSocket.OPEN for ws library; if absent, try sending anyway
        if (typeof client.readyState === 'number' && client.readyState !== 1) continue;
        client.send(payload);
      } catch (_e) {
        // Remove broken clients
        this.clients.delete(client);
      }
    }
  }
}

export const debugModeService = new DebugModeService();
