import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream, promises as fsPromises } from 'fs';
import { pipeline } from 'stream/promises';
import type { ReadStream, WriteStream } from 'fs';
import { DeploymentError, WeightVerificationError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface S3UploadResult {
  path: string;
  size: number;
  uploadedAt: string;
  metadata: Record<string, string>;
}

export interface S3ManagerOptions {
  region?: string;
  bucket?: string;
  endpoint?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface S3ObjectMetadata {
  modelName: string;
  modelHash: string;
  uploadedAt: string;
  fileSize: number;
}

/**
 * S3WeightManager handles streaming uploads and downloads of model weights
 * with retry logic and performance optimization for large files (15GB+)
 */
export class S3WeightManager {
  private readonly client: S3Client;

  private readonly bucket: string;

  private readonly maxRetries: number;

  private readonly retryDelayMs: number;

  constructor(options?: S3ManagerOptions) {
    const s3Config: S3ClientConfig = {
      region: options?.region ?? 'us-east-1',
    };

    const endpoint = options?.endpoint || process.env.AWS_ENDPOINT_URL;
    if (endpoint) {
      s3Config.endpoint = endpoint;
      s3Config.forcePathStyle = true; // Required for Floci/LocalStack
    }

    this.client = new S3Client(s3Config);
    this.bucket = options?.bucket ?? 'auraops-weights';
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
  }

  /**
   * Upload a file to S3 with streaming and retry logic
   * Performance target: 15GB in <20s
   */
  async upload(localPath: string, modelName: string, hash: string): Promise<S3UploadResult> {
    const start = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Get file size for validation
        const stats = await fsPromises.stat(localPath);
        const fileSize = stats.size;

        // Construct S3 key path
        const s3Key = `models/${modelName}/${hash}/weights.bin`;

        // Stream file from disk
        const fileStream: ReadStream = createReadStream(localPath);

        // Prepare metadata
        const metadata: S3ObjectMetadata = {
          modelName,
          modelHash: hash,
          uploadedAt: new Date().toISOString(),
          fileSize,
        };

        // Upload to S3 with streaming
        const uploadCommand = new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: fileStream,
          ContentLength: fileSize,
          Metadata: {
            modelName,
            modelHash: hash,
            uploadedAt: metadata.uploadedAt,
            fileSize: fileSize.toString(),
          },
        });

        await this.client.send(uploadCommand);

        const duration = Date.now() - start;
        const sizeGB = fileSize / 1024 / 1024 / 1024;
        const throughputMBps = (fileSize / 1024 / 1024) / (duration / 1000);

        logger.info(
          `✓ S3 upload complete: ${s3Key} (${sizeGB.toFixed(2)}GB in ${duration}ms, ${throughputMBps.toFixed(2)}MB/s)`,
        );

        return {
          path: s3Key,
          size: fileSize,
          uploadedAt: metadata.uploadedAt,
          metadata: {
            modelName,
            modelHash: hash,
            fileSize: fileSize.toString(),
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `S3 upload attempt ${attempt}/${this.maxRetries} failed: ${lastError.message}`,
        );

        if (attempt < this.maxRetries) {
          const delayMs = this.retryDelayMs * Math.pow(2, attempt - 1);
          await this.delay(delayMs);
        }
      }
    }

    throw new DeploymentError('S3 upload failed after retries', {
      cause: lastError,
      attempts: this.maxRetries,
    });
  }

  /**
   * Download a file from S3 with streaming and retry logic
   * Performance target: 15GB in <15s
   */
  async download(
    s3Path: string,
    localPath: string,
    expectedHash?: string,
  ): Promise<void> {
    const start = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Create write stream
        const writeStream: WriteStream = createWriteStream(localPath);

        // Download from S3 with streaming
        const downloadCommand = new GetObjectCommand({
          Bucket: this.bucket,
          Key: s3Path,
        });

        const response = await this.client.send(downloadCommand);

        if (!response.Body) {
          throw new DeploymentError('S3 download returned empty body');
        }

        // Pipe S3 stream to file
        await pipeline(response.Body as unknown as NodeJS.ReadableStream, writeStream);

        if (expectedHash) {
          await this.verifyWeightHash(localPath, expectedHash);
        }

        const stats = await fsPromises.stat(localPath);
        const duration = Date.now() - start;
        const sizeGB = stats.size / 1024 / 1024 / 1024;
        const throughputMBps = (stats.size / 1024 / 1024) / (duration / 1000);

        logger.info(
          `✓ S3 download complete: ${s3Path} (${sizeGB.toFixed(2)}GB in ${duration}ms, ${throughputMBps.toFixed(2)}MB/s)`,
        );
        return;
      } catch (error) {
        if (error instanceof WeightVerificationError) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `S3 download attempt ${attempt}/${this.maxRetries} failed: ${lastError.message}`,
        );

        // Clean up partially downloaded file on error
        try {
          await fsPromises.unlink(localPath);
        } catch {
          // Ignore cleanup errors
        }

        if (attempt < this.maxRetries) {
          const delayMs = this.retryDelayMs * Math.pow(2, attempt - 1);
          await this.delay(delayMs);
        }
      }
    }

    throw new DeploymentError('S3 download failed after retries', {
      cause: lastError,
      attempts: this.maxRetries,
    });
  }

  /**
   * Verify SHA256 hash of a local weight file matches the expected value
   */
  async verifyWeightHash(localPath: string, expectedHash: string): Promise<void> {
    const start = Date.now();
    const actualHash = await this.computeFileSha256(localPath);

    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new WeightVerificationError('Downloaded weight hash mismatch', {
        expectedHash,
        actualHash,
        localPath,
      });
    }

    logger.info(`✓ Weight hash verified in ${Date.now() - start}ms`);
  }

  private async computeFileSha256(localPath: string): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream(localPath);

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer | string) => {
        hash.update(chunk);
      });
      stream.on('end', () => resolve());
      stream.on('error', (error: Error) => reject(error));
    });

    return hash.digest('hex');
  }

  /**
   * Check if an object exists in S3 (lightweight HEAD request)
   */
  async exists(s3Path: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: s3Path,
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
      logger.warn(`S3 existence check failed: ${String(error)}`);
      return false;
    }
  }

  /**
   * Helper: delay execution for exponential backoff.
   * unref so the timer does not keep the process alive on its own.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  /**
   * Gracefully dispose of S3 client resources
   */
  async dispose(): Promise<void> {
    this.client.destroy();
  }
}
