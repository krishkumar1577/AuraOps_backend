import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream, promises as fsPromises } from 'fs';
import { pipeline } from 'stream/promises';
import type { ReadStream, WriteStream } from 'fs';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface S3UploadResult {
  path: string;
  size: number;
}

export interface S3ManagerOptions {
  region?: string;
  bucket?: string;
  endpoint?: string;
}

export class S3WeightManager {
  private readonly client: S3Client;

  private readonly bucket: string;

  constructor(options?: S3ManagerOptions) {
    this.client = new S3Client({
      region: options?.region ?? 'us-east-1',
      ...(options?.endpoint ? { endpoint: options.endpoint } : {}),
    });
    this.bucket = options?.bucket ?? 'auraops-weights';
  }

  async upload(localPath: string, modelName: string, hash: string): Promise<S3UploadResult> {
    const start = Date.now();
    try {
      // Get file size for validation
      const stats = await fsPromises.stat(localPath);
      const fileSize = stats.size;

      // Construct S3 key path
      const s3Key = `models/${modelName}/${hash}/weights.bin`;

      // Stream file from disk
      const fileStream: ReadStream = createReadStream(localPath);

      // Upload to S3 with streaming
      const uploadCommand = new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: fileStream,
        ContentLength: fileSize,
      });

      await this.client.send(uploadCommand);

      logger.info(`✓ S3 upload complete: ${s3Key} (${fileSize / 1024 / 1024 / 1024}GB in ${Date.now() - start}ms)`);

      return {
        path: s3Key,
        size: fileSize,
      };
    } catch (error) {
      throw new DeploymentError('S3 upload failed', { cause: error });
    }
  }

  async download(s3Path: string, localPath: string): Promise<void> {
    const start = Date.now();
    try {
      // Parse S3 path (bucket/key or just key)
      const [bucket, ...keyParts] = s3Path.includes('/') ? s3Path.split('/') : [this.bucket, s3Path];
      const key = keyParts.join('/');

      // Create write stream
      const writeStream: WriteStream = createWriteStream(localPath);

      // Download from S3 with streaming
      const downloadCommand = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.client.send(downloadCommand);

      if (!response.Body) {
        throw new DeploymentError('S3 download returned empty body');
      }

      // Pipe S3 stream to file
      await pipeline(response.Body as NodeJS.ReadableStream, writeStream);

      const stats = await fsPromises.stat(localPath);
      logger.info(`✓ S3 download complete: ${key} (${stats.size / 1024 / 1024 / 1024}GB in ${Date.now() - start}ms)`);
    } catch (error) {
      // Clean up partially downloaded file on error
      try {
        await fsPromises.unlink(localPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new DeploymentError('S3 download failed', { cause: error });
    }
  }

  async exists(s3Path: string): Promise<boolean> {
    try {
      // Parse S3 path (bucket/key or just key)
      const [bucket, ...keyParts] = s3Path.includes('/') ? s3Path.split('/') : [this.bucket, s3Path];
      const key = keyParts.join('/');

      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return false;
      }
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound') {
        return false;
      }
      // For any other error, log and return false
      logger.info(`S3 existence check failed: ${String(error)}`);
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.client.destroy();
  }
}
