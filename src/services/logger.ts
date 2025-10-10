import { FastifyReply } from 'fastify';

// 实时日志推送增强
class RealtimeEnhancement {
  private clients: Set<FastifyReply> = new Set();

  addClient(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.clients.add(reply);
    reply.raw.on('close', () => this.clients.delete(reply));
  }

  broadcast(level: string, message: string, module?: string): void {
    if (this.clients.size === 0) return;

    const data = `data: ${JSON.stringify({
      time: new Date().toLocaleTimeString(),
      level,
      message,
      module
    })}\n\n`;

    for (const client of this.clients) {
      try {
        client.raw.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

const realtimeEnhancement = new RealtimeEnhancement();

export interface LogEntry {
  timestamp: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  module?: string;
  metadata?: Record<string, any>;
}

class MemoryLogger {
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;

  log(level: LogEntry['level'], message: string, module?: string, metadata?: Record<string, any>) {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      module,
      metadata,
    };

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    console.log(`[${level}] ${module ? `[${module}] ` : ''}${message}`, metadata || '');

    // 实时推送
    realtimeEnhancement.broadcast(level, message, module);
  }

  info(message: string, module?: string, metadata?: Record<string, any>) {
    this.log('INFO', message, module, metadata);
  }

  warn(message: string, module?: string, metadata?: Record<string, any>) {
    this.log('WARN', message, module, metadata);
  }

  error(message: string, module?: string, metadata?: Record<string, any>) {
    this.log('ERROR', message, module, metadata);
  }

  debug(message: string, module?: string, metadata?: Record<string, any>) {
    this.log('DEBUG', message, module, metadata);
  }

  getLogs(options?: {
    level?: LogEntry['level'];
    limit?: number;
    search?: string;
  }): LogEntry[] {
    let filtered = [...this.logs];

    if (options?.level) {
      filtered = filtered.filter(log => log.level === options.level);
    }

    if (options?.search) {
      const searchLower = options.search.toLowerCase();
      filtered = filtered.filter(log => 
        log.message.toLowerCase().includes(searchLower) ||
        log.module?.toLowerCase().includes(searchLower)
      );
    }

    if (options?.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  }

  clear() {
    this.logs = [];
  }

  getStats() {
    const stats = {
      total: this.logs.length,
      byLevel: {
        INFO: 0,
        WARN: 0,
        ERROR: 0,
        DEBUG: 0,
      },
    };

    this.logs.forEach(log => {
      stats.byLevel[log.level]++;
    });

    return stats;
  }
}

export const memoryLogger = new MemoryLogger();

// 导出实时日志功能
export const realtimeLogger = realtimeEnhancement;

