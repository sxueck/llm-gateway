import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { memoryLogger } from './logger.js';
import { systemConfigDb } from '../db/index.js';

export interface S3Config {
  endpoint: string;
  bucketName: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3StorageService {
  private client: S3Client | null = null;
  private config: S3Config | null = null;

  async initializeFromConfig(): Promise<void> {
    // Load S3 config from database
    const endpoint = await systemConfigDb.get('s3_endpoint');
    const bucketName = await systemConfigDb.get('s3_bucket_name');
    const region = await systemConfigDb.get('s3_region');
    const accessKeyId = await systemConfigDb.get('s3_access_key_id');
    const secretAccessKey = await systemConfigDb.get('s3_secret_access_key');
    const forcePathStyle = await systemConfigDb.get('s3_force_path_style');

    if (!endpoint?.value || !bucketName?.value || !accessKeyId?.value || !secretAccessKey?.value) {
      throw new Error('S3 configuration incomplete. Please configure S3 settings in the backup page.');
    }

    this.config = {
      endpoint: endpoint.value,
      bucketName: bucketName.value,
      region: region?.value || 'us-east-1',
      accessKeyId: accessKeyId.value,
      secretAccessKey: secretAccessKey.value,
      forcePathStyle: forcePathStyle?.value === 'true'
    };

    this.initializeClient(this.config);
  }

  initializeClient(config: S3Config): void {
    const clientConfig: any = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    };

    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
      memoryLogger.info(`Using S3-compatible endpoint: ${config.endpoint}`, 'Backup');
    }

    if (config.forcePathStyle !== undefined) {
      clientConfig.forcePathStyle = config.forcePathStyle;
    }

    this.client = new S3Client(clientConfig);
    this.config = config;
  }

  async uploadFile(localPath: string, s3Key: string): Promise<void> {
    if (!this.client || !this.config) {
      await this.initializeFromConfig();
    }

    try {
      const fileStream = createReadStream(localPath);
      const uploadParams = {
        Bucket: this.config!.bucketName,
        Key: s3Key,
        Body: fileStream
      };

      await this.client!.send(new PutObjectCommand(uploadParams));
      memoryLogger.info(`Uploaded backup to S3: ${s3Key}`, 'Backup');
    } catch (error: any) {
      memoryLogger.error(`Failed to upload to S3: ${error.message}`, 'Backup');
      throw error;
    }
  }

  async downloadFile(s3Key: string, localPath: string): Promise<void> {
    if (!this.client || !this.config) {
      await this.initializeFromConfig();
    }

    try {
      const downloadParams = {
        Bucket: this.config!.bucketName,
        Key: s3Key
      };

      const response = await this.client!.send(new GetObjectCommand(downloadParams));

      if (!response.Body) {
        throw new Error('Empty response body from S3');
      }

      const fileStream = createWriteStream(localPath);
      await pipeline(response.Body as any, fileStream);

      memoryLogger.info(`Downloaded backup from S3: ${s3Key}`, 'Backup');
    } catch (error: any) {
      memoryLogger.error(`Failed to download from S3: ${error.message}`, 'Backup');
      throw error;
    }
  }

  async deleteFile(s3Key: string): Promise<void> {
    if (!this.client || !this.config) {
      await this.initializeFromConfig();
    }

    try {
      const deleteParams = {
        Bucket: this.config!.bucketName,
        Key: s3Key
      };

      await this.client!.send(new DeleteObjectCommand(deleteParams));
      memoryLogger.info(`Deleted backup from S3: ${s3Key}`, 'Backup');
    } catch (error: any) {
      memoryLogger.error(`Failed to delete from S3: ${error.message}`, 'Backup');
      throw error;
    }
  }

  async testConnection(): Promise<boolean> {
    if (!this.client || !this.config) {
      await this.initializeFromConfig();
    }

    try {
      const testParams = {
        Bucket: this.config!.bucketName,
        Key: '.test-connection',
        Body: Buffer.from('test')
      };

      await this.client!.send(new PutObjectCommand(testParams));
      await this.client!.send(new DeleteObjectCommand({
        Bucket: this.config!.bucketName,
        Key: '.test-connection'
      }));

      return true;
    } catch (error) {
      return false;
    }
  }
}

let s3ServiceInstance: S3StorageService | null = null;

export function getS3Service(): S3StorageService {
  if (!s3ServiceInstance) {
    s3ServiceInstance = new S3StorageService();
  }
  return s3ServiceInstance;
}
