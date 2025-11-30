import * as cron from 'node-cron';
import { BackupService } from './backup-service.js';
import { backupDb } from '../db/backup.js';
import { memoryLogger } from './logger.js';

export class BackupScheduler {
  private backupService: BackupService;
  private cronJob: cron.ScheduledTask | null = null;
  private cleanupJob: cron.ScheduledTask | null = null;
  private schedule: string;
  private retentionDays: number;
  private maxBackupCount: number;
  private includeLogs: boolean;

  constructor() {
    this.backupService = new BackupService();
    this.schedule = process.env.BACKUP_SCHEDULE_CRON || '0 2 * * 2'; // Default: 2 AM every Tuesday
    this.retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
    this.maxBackupCount = parseInt(process.env.BACKUP_MAX_COUNT || '50', 10);
    this.includeLogs = process.env.BACKUP_INCLUDE_LOGS === 'true';
  }

  start(): void {
    if (this.cronJob) {
      memoryLogger.warn('Backup scheduler already running', 'Backup');
      return;
    }

    // Validate cron schedule
    if (!cron.validate(this.schedule)) {
      memoryLogger.error(`Invalid cron schedule: ${this.schedule}`, 'Backup');
      return;
    }

    // Schedule automated backups
    this.cronJob = cron.schedule(this.schedule, async () => {
      try {
        memoryLogger.info('Scheduled backup started', 'Backup');
        await this.triggerBackup();
      } catch (error: any) {
        memoryLogger.error(`Scheduled backup failed: ${error.message}`, 'Backup');
      }
    });

    // Schedule cleanup task (runs daily at 3 AM)
    this.cleanupJob = cron.schedule('0 3 * * *', async () => {
      try {
        await this.cleanupOldBackups();
      } catch (error: any) {
        memoryLogger.error(`Backup cleanup failed: ${error.message}`, 'Backup');
      }
    });

    memoryLogger.info(`Backup scheduler started with schedule: ${this.schedule}`, 'Backup');
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      memoryLogger.info('Backup scheduler stopped', 'Backup');
    }

    if (this.cleanupJob) {
      this.cleanupJob.stop();
      this.cleanupJob = null;
    }
  }

  async triggerBackup(): Promise<void> {
    try {
      const backup = await this.backupService.createFullBackup({
        backup_type: 'full',
        includes_logs: this.includeLogs
      });

      memoryLogger.info(
        `Manual backup triggered: ${backup.id}`,
        'Backup'
      );
    } catch (error: any) {
      memoryLogger.error(`Manual backup failed: ${error.message}`, 'Backup');
      throw error;
    }
  }

  private async cleanupOldBackups(): Promise<void> {
    try {
      memoryLogger.info('Starting backup cleanup', 'Backup');

      await backupDb.cleanupOldBackups(this.retentionDays, this.maxBackupCount);

      memoryLogger.info(
        `Backup cleanup completed (retention: ${this.retentionDays} days, max: ${this.maxBackupCount})`,
        'Backup'
      );
    } catch (error: any) {
      memoryLogger.error(`Backup cleanup error: ${error.message}`, 'Backup');
      throw error;
    }
  }

  updateSchedule(newSchedule: string): void {
    if (!cron.validate(newSchedule)) {
      throw new Error(`Invalid cron schedule: ${newSchedule}`);
    }

    this.stop();
    this.schedule = newSchedule;
    this.start();

    memoryLogger.info(`Backup schedule updated to: ${newSchedule}`, 'Backup');
  }

  getStatus(): {
    running: boolean;
    schedule: string;
    retentionDays: number;
    maxBackupCount: number;
    includeLogs: boolean;
  } {
    return {
      running: this.cronJob !== null,
      schedule: this.schedule,
      retentionDays: this.retentionDays,
      maxBackupCount: this.maxBackupCount,
      includeLogs: this.includeLogs
    };
  }
}

let schedulerInstance: BackupScheduler | null = null;

export function getBackupScheduler(): BackupScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new BackupScheduler();
  }
  return schedulerInstance;
}
