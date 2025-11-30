import type { FastifyInstance } from 'fastify';
import { BackupService } from '../services/backup-service.js';
import { RestoreService } from '../services/restore-service.js';
import { getBackupScheduler } from '../services/backup-scheduler.js';
import { backupDb, restoreDb } from '../db/backup.js';
import { getS3Service } from '../services/s3-storage.js';
import { systemConfigDb } from '../db/index.js';
import type { S3Config } from '../services/s3-storage.js';

const backupService = new BackupService();
const restoreService = new RestoreService();

export default async function backupRoutes(fastify: FastifyInstance) {
  // Get S3 configuration
  fastify.get('/api/admin/backup/s3-config', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const endpoint = await systemConfigDb.get('s3_endpoint');
        const bucketName = await systemConfigDb.get('s3_bucket_name');
        const region = await systemConfigDb.get('s3_region');
        const accessKeyId = await systemConfigDb.get('s3_access_key_id');
        const forcePathStyle = await systemConfigDb.get('s3_force_path_style');

        reply.send({
          endpoint: endpoint?.value || '',
          bucketName: bucketName?.value || '',
          region: region?.value || 'us-east-1',
          accessKeyId: accessKeyId?.value || '',
          secretAccessKey: '******', // Never return actual secret
          forcePathStyle: forcePathStyle?.value === 'true'
        });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'config_error',
            code: 'get_s3_config_failed'
          }
        });
      }
    }
  });

  // Save S3 configuration
  fastify.put('/api/admin/backup/s3-config', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const body = request.body as {
          endpoint: string;
          bucketName: string;
          region: string;
          accessKeyId: string;
          secretAccessKey: string;
          forcePathStyle: boolean;
        };

        // Validate required fields (except secretAccessKey which can be kept unchanged)
        if (!body.endpoint || !body.bucketName || !body.accessKeyId) {
          return reply.code(400).send({
            error: {
              message: 'Missing required fields',
              type: 'invalid_request',
              code: 'missing_fields'
            }
          });
        }

        // Get existing secret key if not provided or if placeholder is sent
        let secretAccessKey = body.secretAccessKey;
        if (!secretAccessKey || secretAccessKey === '******') {
          const existingSecret = await systemConfigDb.get('s3_secret_access_key');
          if (!existingSecret?.value) {
            return reply.code(400).send({
              error: {
                message: 'Secret access key is required',
                type: 'invalid_request',
                code: 'missing_secret_key'
              }
            });
          }
          secretAccessKey = existingSecret.value;
        }

        // Save to system_config
        await systemConfigDb.set('s3_endpoint', body.endpoint, 'S3 endpoint URL');
        await systemConfigDb.set('s3_bucket_name', body.bucketName, 'S3 bucket name');
        await systemConfigDb.set('s3_region', body.region || 'us-east-1', 'S3 region');
        await systemConfigDb.set('s3_access_key_id', body.accessKeyId, 'S3 access key ID');
        await systemConfigDb.set('s3_secret_access_key', secretAccessKey, 'S3 secret access key');
        await systemConfigDb.set('s3_force_path_style', body.forcePathStyle ? 'true' : 'false', 'S3 force path style');

        // Reset S3 service to use new config
        const s3Service = getS3Service();
        s3Service.initializeClient({
          endpoint: body.endpoint,
          bucketName: body.bucketName,
          region: body.region || 'us-east-1',
          accessKeyId: body.accessKeyId,
          secretAccessKey,
          forcePathStyle: body.forcePathStyle
        });

        reply.send({ message: 'S3 configuration saved successfully' });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'config_error',
            code: 'save_s3_config_failed'
          }
        });
      }
    }
  });

  // Test S3 connection
  fastify.post('/api/admin/backup/test-s3', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const body = request.body as S3Config | undefined;

        if (body) {
          // Test with provided config
          const s3Service = getS3Service();
          s3Service.initializeClient(body);
          const result = await s3Service.testConnection();

          reply.send({
            connected: result.success,
            message: result.success ? 'S3 connection successful' : 'S3 connection failed',
            error: result.error
          });
        } else {
          // Test with saved config
          const s3Service = getS3Service();
          const result = await s3Service.testConnection();

          reply.send({
            connected: result.success,
            message: result.success ? 'S3 connection successful' : 'S3 connection failed',
            error: result.error
          });
        }
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 's3_error',
            code: 's3_test_failed'
          }
        });
      }
    }
  });

  // Create backup
  fastify.post('/api/admin/backup/create', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const body = request.body as {
          includes_logs?: boolean;
          backup_type?: 'full' | 'incremental';
        };

        // Start backup asynchronously
        const backupType = body.backup_type || 'full';
        const backupPromise = backupType === 'incremental'
          ? backupService.createIncrementalBackup({
              includes_logs: body.includes_logs || false
            })
          : backupService.createFullBackup({
              includes_logs: body.includes_logs || false
            });

        // Return immediately with pending status
        reply.send({
          message: 'Backup task started',
          status: 'running'
        });

        // Execute backup in background
        backupPromise.catch((error) => {
          console.error('Background backup failed:', error);
        });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'backup_error',
            code: 'backup_failed'
          }
        });
      }
    }
  });

  // List backups
  fastify.get('/api/admin/backup/list', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const query = request.query as {
          page?: string;
          limit?: string;
          status?: string;
        };

        const result = await backupDb.listBackupRecords({
          page: parseInt(query.page || '1', 10),
          limit: parseInt(query.limit || '10', 10),
          status: query.status || 'all'
        });

        reply.send({
          backups: result.records,
          total: result.total,
          page: parseInt(query.page || '1', 10),
          limit: parseInt(query.limit || '10', 10)
        });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'backup_error',
            code: 'list_failed'
          }
        });
      }
    }
  });

  // Get backup details
  fastify.get('/api/admin/backup/:id', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const params = request.params as { id: string };
        const backup = await backupDb.getBackupRecord(params.id);

        if (!backup) {
          return reply.code(404).send({
            error: {
              message: 'Backup not found',
              type: 'not_found',
              code: 'backup_not_found'
            }
          });
        }

        reply.send(backup);
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'backup_error',
            code: 'get_failed'
          }
        });
      }
    }
  });

  // Delete backup
  fastify.delete('/api/admin/backup/:id', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const params = request.params as { id: string };
        const backup = await backupDb.getBackupRecord(params.id);

        if (!backup) {
          return reply.code(404).send({
            error: {
              message: 'Backup not found',
              type: 'not_found',
              code: 'backup_not_found'
            }
          });
        }

        // Delete from S3
        try {
          const s3Service = getS3Service();
          await s3Service.deleteFile(backup.s3_key);
        } catch (error) {
          console.error('Failed to delete from S3:', error);
        }

        // Delete from database
        await backupDb.deleteBackupRecord(params.id);

        reply.send({ message: 'Backup deleted' });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'backup_error',
            code: 'delete_failed'
          }
        });
      }
    }
  });

  // Create restore
  fastify.post('/api/admin/restore', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const body = request.body as {
          backup_id: string;
          restore_type?: 'full' | 'partial';
          create_backup_before_restore?: boolean;
          tables_to_restore?: string[];
        };

        if (!body.backup_id) {
          return reply.code(400).send({
            error: {
              message: 'backup_id is required',
              type: 'invalid_request',
              code: 'missing_backup_id'
            }
          });
        }

        // Validate partial restore
        if (body.restore_type === 'partial' && (!body.tables_to_restore || body.tables_to_restore.length === 0)) {
          return reply.code(400).send({
            error: {
              message: 'tables_to_restore is required for partial restore',
              type: 'invalid_request',
              code: 'missing_tables'
            }
          });
        }

        // Start restore asynchronously
        const restorePromise = restoreService.restoreFromBackup(body.backup_id, {
          restore_type: body.restore_type || 'full',
          create_backup_before_restore: body.create_backup_before_restore !== false,
          tables_to_restore: body.tables_to_restore
        });

        reply.send({
          message: 'Restore task started',
          status: 'pending'
        });

        // Execute restore in background
        restorePromise.catch((error) => {
          console.error('Background restore failed:', error);
        });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'restore_error',
            code: 'restore_failed'
          }
        });
      }
    }
  });

  // List restores
  fastify.get('/api/admin/restore/list', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const query = request.query as {
          page?: string;
          limit?: string;
          status?: string;
        };

        const result = await restoreDb.listRestoreRecords({
          page: parseInt(query.page || '1', 10),
          limit: parseInt(query.limit || '10', 10),
          status: query.status || 'all'
        });

        // Parse changes_made JSON for each record
        const restores = result.records.map(record => ({
          ...record,
          changes_made: record.changes_made ? JSON.parse(record.changes_made) : null
        }));

        reply.send({
          restores,
          total: result.total,
          page: parseInt(query.page || '1', 10),
          limit: parseInt(query.limit || '10', 10)
        });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'restore_error',
            code: 'list_failed'
          }
        });
      }
    }
  });

  // Get restore details
  fastify.get('/api/admin/restore/:id', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const params = request.params as { id: string };
        const restore = await restoreDb.getRestoreRecord(params.id);

        if (!restore) {
          return reply.code(404).send({
            error: {
              message: 'Restore record not found',
              type: 'not_found',
              code: 'restore_not_found'
            }
          });
        }

        // Parse changes_made JSON
        const result = {
          ...restore,
          changes_made: restore.changes_made ? JSON.parse(restore.changes_made) : null
        };

        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'restore_error',
            code: 'get_failed'
          }
        });
      }
    }
  });

  // Rollback restore
  fastify.post('/api/admin/restore/:id/rollback', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const params = request.params as { id: string };

        await restoreService.rollbackRestore(params.id);

        reply.send({ message: 'Rollback task started' });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'restore_error',
            code: 'rollback_failed'
          }
        });
      }
    }
  });

  // Get backup configuration
  fastify.get('/api/admin/backup/config', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const scheduler = getBackupScheduler();
        const status = scheduler.getStatus();

        reply.send({
          schedule: status.schedule,
          retention_days: status.retentionDays,
          max_backup_count: status.maxBackupCount,
          include_logs: status.includeLogs,
          encryption_enabled: true,
          compression_enabled: true,
          scheduler_running: status.running
        });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'config_error',
            code: 'get_config_failed'
          }
        });
      }
    }
  });

  // Update backup configuration
  fastify.put('/api/admin/backup/config', {
    onRequest: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const body = request.body as {
          schedule?: string;
        };

        if (body.schedule) {
          const scheduler = getBackupScheduler();
          scheduler.updateSchedule(body.schedule);
        }

        reply.send({ message: 'Configuration updated' });
      } catch (error: any) {
        reply.code(500).send({
          error: {
            message: error.message,
            type: 'config_error',
            code: 'update_config_failed'
          }
        });
      }
    }
  });
}
