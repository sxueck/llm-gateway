
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


