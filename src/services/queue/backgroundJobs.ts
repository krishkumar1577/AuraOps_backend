import Queue from 'bull';
import { createClient, RedisClientType } from 'redis';
import axios from 'axios';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { logger } from '../../utils/logger';
import { DeploymentError, ValidationError } from '../../utils/errors';
import { S3WeightManager } from '../swr/s3Manager';
import { RedisWeightRegistry, CachedWeight } from '../swr/redisClient';

interface JobData {
  modelName: string;
  modelHash: string;
  source: 'huggingface' | 'custom-url';
  sourceUrl?: string;
  retries: number;
}

interface JobStatus {
  id: string;
  state: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
}

interface JobProgress {
  percent: number;
  bytes?: number;
}

interface QueueStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
}

/**
 * BackgroundJobQueue manages asynchronous weight pull operations using Bull queue.
 * Handles download → S3 upload → Redis registration workflow with retry logic.
 */
export class BackgroundJobQueue {
  private queue: Queue.Queue<JobData>;

  private redisClient: RedisClientType;

  private s3Manager: S3WeightManager;

  private redisRegistry: RedisWeightRegistry;

  private ready: boolean = false;

  constructor(
    s3Manager?: S3WeightManager,
    redisRegistry?: RedisWeightRegistry,
    redisClient?: RedisClientType,
  ) {
    this.redisClient =
      redisClient ??
      (createClient({
        socket: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
        },
      }) as unknown as RedisClientType);

    this.s3Manager = s3Manager ?? new S3WeightManager();
    this.redisRegistry = redisRegistry ?? new RedisWeightRegistry();

    this.queue = new Queue('weight-pull', {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }

  /**
   * Initialize the queue and set up job processors
   */
  async initialize(): Promise<void> {
    try {
      await this.redisClient.connect();

      // Set up job processor (3 concurrent processors)
      this.queue.process(3, async (job: Queue.Job<JobData>) => {
        return this.handleWeightPull(job);
      });

      // Set up event handlers
      this.queue.on('completed', (job: Queue.Job<JobData>) => {
        logger.info(
          `✓ Weight pull completed: ${job.data.modelName} (job: ${job.id})`,
        );
      });

      this.queue.on('failed', (job: Queue.Job<JobData>, err: Error) => {
        logger.error(
          `✗ Weight pull failed: ${job.data.modelName} (job: ${job.id}): ${err.message}`,
        );
      });

      this.queue.on('error', (err: Error) => {
        logger.error(`Queue error: ${err.message}`);
      });

      this.ready = true;
      logger.info('✓ BackgroundJobQueue initialized');
    } catch (error) {
      throw new DeploymentError('Failed to initialize BackgroundJobQueue', {
        cause: error,
      });
    }
  }

  /**
   * Queue a weight pull job (non-blocking, returns immediately)
   * Returns jobId immediately without waiting for completion
   */
  async queueWeightPull(
    modelName: string,
    modelHash: string,
    source: 'huggingface' | 'custom-url',
    sourceUrl?: string,
  ): Promise<string> {
    const start = Date.now();

    try {
      this.validateInputs(modelName, modelHash, source, sourceUrl);

      if (!this.ready) {
        throw new DeploymentError('Queue not initialized');
      }

      const jobData: JobData = {
        modelName,
        modelHash,
        source,
        sourceUrl,
        retries: 0,
      };

      const job = await this.queue.add(jobData, {
        jobId: `${modelName}-${modelHash}`,
      });

      logger.info(
        `✓ Weight pull queued: ${modelName} (hash: ${modelHash}, source: ${source}, jobId: ${job.id}, ${Date.now() - start}ms)`,
      );

      return job.id as string;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DeploymentError) {
        logger.error(`Failed to queue weight pull: ${error}`);
        throw error;
      }
      logger.error(`Failed to queue weight pull: ${error}`);
      throw new DeploymentError('Failed to queue weight pull', { cause: error });
    }
  }

  /**
   * Get status of a queued job
   */
  async getJobStatus(jobId: string): Promise<JobStatus | null> {
    try {
      const job = await this.queue.getJob(jobId);

      if (!job) {
        return null;
      }

      const state = await job.getState();
      const progress = job.progress();

      return {
        id: job.id as string,
        state: state as JobStatus['state'],
        progress: typeof progress === 'number' ? progress : 0,
      };
    } catch (error) {
      logger.error(`Failed to get job status: ${error}`);
      return null;
    }
  }

  /**
   * Get progress of a queued job
   */
  async getJobProgress(jobId: string): Promise<JobProgress | null> {
    try {
      const job = await this.queue.getJob(jobId);

      if (!job) {
        return null;
      }

      const progress = job.progress();

      return {
        percent: typeof progress === 'number' ? progress : 0,
      };
    } catch (error) {
      logger.error(`Failed to get job progress: ${error}`);
      return null;
    }
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<QueueStats> {
    try {
      const counts = await this.queue.getJobCounts();

      return {
        pending: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
      };
    } catch (error) {
      logger.error(`Failed to get queue stats: ${error}`);
      return {
        pending: 0,
        active: 0,
        completed: 0,
        failed: 0,
      };
    }
  }

  /**
   * Clean up failed jobs from the queue
   */
  async cleanupFailedJobs(): Promise<void> {
    try {
      const failedJobs = await this.queue.getFailed();
      await this.queue.clean(0, 'failed');

      logger.info(
        `✓ Cleanup complete: ${failedJobs.length} failed jobs cleaned up`,
      );
    } catch (error) {
      logger.error(`Failed to cleanup failed jobs: ${error}`);
    }
  }

  /**
   * Check if queue is ready
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Dispose of queue resources
   */
  async dispose(): Promise<void> {
    try {
      if (this.queue) {
        await this.queue.close();
      }

      if (this.redisClient && this.redisClient.isOpen) {
        await this.redisClient.disconnect();
      }

      this.ready = false;
      logger.info('✓ BackgroundJobQueue disposed');
    } catch (error) {
      logger.error(`Failed to dispose BackgroundJobQueue: ${error}`);
    }
  }

  /**
   * Process weight pull: download → upload to S3 → register in Redis
   */
  private async handleWeightPull(job: Queue.Job<JobData>): Promise<void> {
    const { modelName, modelHash, source, sourceUrl } = job.data;
    const timestamp = Date.now();
    let downloadPath: string | null = null;

    try {
      job.progress(10);

      // Download weight from source
      downloadPath = await this.downloadWeight(
        modelName,
        modelHash,
        source,
        sourceUrl,
      );
      logger.debug(
        `Downloaded weight to ${downloadPath} (${Date.now() - timestamp}ms)`,
      );
      job.progress(50);

      // Upload to S3
      const uploadResult = await this.s3Manager.upload(
        downloadPath,
        modelName,
        modelHash,
      );
      logger.debug(`Uploaded to S3: ${uploadResult.path}`);
      job.progress(80);

      // Register in Redis with cache metadata
      const cachedWeight: CachedWeight = {
        modelHash,
        framework: 'unknown',
        sizeGB: uploadResult.size / 1024 / 1024 / 1024,
        storagePath: uploadResult.path,
        mountPoint: `/weights/${modelName}`,
        lastAccessed: Date.now(),
        cacheHits: 0,
        ttlSeconds: 2_592_000, // 30 days
      };

      await this.redisRegistry.register(cachedWeight);
      logger.debug(`Registered in Redis cache: ${modelHash}`);
      job.progress(100);

      logger.info(
        `✓ Weight pull complete: ${modelName} (hash: ${modelHash}, ${Date.now() - timestamp}ms)`,
      );
    } catch (error) {
      logger.error(
        `Failed to process weight pull for ${modelName}: ${error}`,
      );
      throw error instanceof DeploymentError
        ? error
        : new DeploymentError('Failed to process weight pull', { cause: error });
    } finally {
      // Cleanup local file
      if (downloadPath) {
        try {
          await fs.unlink(downloadPath);
          logger.debug(`Cleaned up local file: ${downloadPath}`);
        } catch (err) {
          logger.warn(`Failed to cleanup file ${downloadPath}: ${err}`);
        }
      }
    }
  }

  /**
   * Download weight from HuggingFace or custom URL
   */
  private async downloadWeight(
    modelName: string,
    modelHash: string,
    source: 'huggingface' | 'custom-url',
    sourceUrl?: string,
  ): Promise<string> {
    const timestamp = Date.now();
    const downloadDir = process.env.WEIGHTS_DOWNLOAD_DIR || './weights-cache';

    try {
      // Ensure download directory exists
      await fs.mkdir(downloadDir, { recursive: true });

      const downloadPath = `${downloadDir}/${modelName}-${modelHash}.bin`;

      let downloadUrl: string;

      if (source === 'huggingface') {
        downloadUrl = `https://huggingface.co/${modelName}/resolve/main/pytorch_model.bin`;
      } else if (source === 'custom-url' && sourceUrl) {
        downloadUrl = sourceUrl;
      } else {
        throw new ValidationError('Invalid source configuration for download');
      }

      logger.debug(
        `Starting download: ${modelName} from ${downloadUrl} to ${downloadPath}`,
      );

      const response = await axios.get(downloadUrl, {
        responseType: 'stream',
        timeout: 300000, // 5 minute timeout for large files
      });

      const writeStream = createWriteStream(downloadPath);
      await pipeline(response.data as Readable, writeStream);

      const stats = await fs.stat(downloadPath);

      logger.info(
        `✓ Download complete: ${modelName} (${(stats.size / 1024 / 1024).toFixed(2)}MB in ${Date.now() - timestamp}ms)`,
      );

      return downloadPath;
    } catch (error) {
      logger.error(
        `Failed to download weight ${modelName}: ${error}`,
      );
      throw new DeploymentError('Failed to download weight', {
        modelName,
        source,
        cause: error,
      });
    }
  }

  /**
   * Validate queue input parameters
   */
  private validateInputs(
    modelName: string,
    modelHash: string,
    source: string,
    sourceUrl?: string,
  ): void {
    if (!modelName || modelName.trim().length === 0) {
      throw new ValidationError('Model name cannot be empty');
    }

    if (!modelHash || modelHash.trim().length === 0) {
      throw new ValidationError('Model hash cannot be empty');
    }

    if (source !== 'huggingface' && source !== 'custom-url') {
      throw new ValidationError(
        'Source must be "huggingface" or "custom-url"',
      );
    }

    if (source === 'custom-url') {
      if (!sourceUrl || sourceUrl.trim().length === 0) {
        throw new ValidationError(
          'sourceUrl is required when source is "custom-url"',
        );
      }

      if (!sourceUrl.startsWith('http://') && !sourceUrl.startsWith('https://')) {
        throw new ValidationError('sourceUrl must be a valid HTTP(S) URL');
      }
    }
  }
}
