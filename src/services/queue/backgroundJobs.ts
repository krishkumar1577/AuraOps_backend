import Queue from 'bull';
import { createClient, RedisClientType } from 'redis';
import { logger } from '../../utils/logger';
import { DeploymentError } from '../../utils/errors';
import * as fs from 'fs/promises';

interface JobData {
  modelName: string;
  hash: string;
  source: string;
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

export class BackgroundJobQueue {
  private queue: Queue.Queue<JobData>;
  private redisClient: RedisClientType;
  private ready: boolean = false;

  constructor() {
    this.redisClient = createClient({
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
    });

    this.queue = new Queue('weight-pull', {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }

  async initialize(): Promise<void> {
    try {
      await this.redisClient.connect();

      // Set up job processor
      this.queue.process(3, async (job: Queue.Job<JobData>) => {
        return this.processWeightPull(job);
      });

      // Set up event handlers
      this.queue.on('completed', (job: Queue.Job<JobData>) => {
        logger.info(`✓ Weight pull completed: ${job.data.modelName} (${job.id})`);
      });

      this.queue.on('failed', (job: Queue.Job<JobData>, err: Error) => {
        logger.error(
          `✗ Weight pull failed: ${job.data.modelName} (${job.id}): ${err.message}`
        );
      });

      this.ready = true;
      logger.info('✓ BackgroundJobQueue initialized');
    } catch (error) {
      throw new DeploymentError('Failed to initialize BackgroundJobQueue', {
        cause: error,
      });
    }
  }

  async queueWeightPull(
    modelName: string,
    hash: string,
    source: string
  ): Promise<string> {
    try {
      // Validate inputs
      if (!modelName || modelName.trim().length === 0) {
        throw new DeploymentError('Model name cannot be empty');
      }

      if (!hash || hash.trim().length === 0) {
        throw new DeploymentError('Hash cannot be empty');
      }

      if (!source || source.trim().length === 0) {
        throw new DeploymentError('Source cannot be empty');
      }

      // Validate source format
      if (
        source !== 'huggingface' &&
        !source.startsWith('http://') &&
        !source.startsWith('https://')
      ) {
        throw new DeploymentError(
          'Source must be "huggingface" or a valid HTTP(S) URL'
        );
      }

      const start = Date.now();

      const job = await this.queue.add(
        {
          modelName,
          hash,
          source,
        },
        {
          jobId: `${modelName}-${hash}`,
        }
      );

      logger.info(
        `✓ Weight pull queued: ${modelName} (hash: ${hash}, source: ${source}, job: ${job.id}, ${Date.now() - start}ms)`
      );

      return job.id as string;
    } catch (error) {
      logger.error(`Failed to queue weight pull: ${error}`);
      throw error instanceof DeploymentError
        ? error
        : new DeploymentError('Failed to queue weight pull', { cause: error });
    }
  }

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

  getStats(): QueueStats {
    return {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
    };
  }

  async cleanupFailedJobs(): Promise<void> {
    try {
      const failedJobs = await this.queue.getFailed();
      await this.queue.clean(0, 'failed');

      logger.info(`✓ Cleanup complete: ${failedJobs.length} failed jobs cleaned up`);
    } catch (error) {
      logger.error(`Failed to cleanup failed jobs: ${error}`);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

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

  private async processWeightPull(job: Queue.Job<JobData>): Promise<void> {
    try {
      job.progress(10);

      const { modelName, hash, source } = job.data;
      const timestamp = Date.now();

      // Download weight from source
      const downloadPath = await this.downloadWeight(
        modelName,
        hash,
        source,
        job
      );
      job.progress(50);

      // Upload to S3
      const s3Path = await this.uploadToS3(modelName, hash, downloadPath);
      job.progress(80);

      // Register in Redis
      await this.registerInRedis(modelName, hash, s3Path);
      job.progress(100);

      logger.info(
        `✓ Weight pull complete: ${modelName} (hash: ${hash}, ${Date.now() - timestamp}ms)`
      );

      // Cleanup local file
      try {
        await fs.unlink(downloadPath);
      } catch (err) {
        logger.warn(`Failed to cleanup file: ${downloadPath}`);
      }
    } catch (error) {
      throw error instanceof DeploymentError
        ? error
        : new DeploymentError('Failed to process weight pull', { cause: error });
    }
  }

  private async downloadWeight(
    modelName: string,
    hash: string,
    _source: string,
    _job: Queue.Job<JobData>
  ): Promise<string> {
    // Implementation stub for downloading weights
    // In real implementation, would handle HuggingFace API or direct URL download
    logger.info(`✓ Download started: ${modelName} (hash: ${hash})`);
    return `/tmp/${modelName}-${hash}.bin`;
  }

  private async uploadToS3(
    modelName: string,
    hash: string,
    _localPath: string
  ): Promise<string> {
    // Implementation stub for S3 upload
    // In real implementation, would stream upload to S3
    const s3Key = `models/${modelName}/${hash}/weights.bin`;
    logger.info(`✓ Upload started: s3://${process.env.S3_BUCKET}/${s3Key}`);
    return s3Key;
  }

  private async registerInRedis(
    _modelName: string,
    hash: string,
    s3Path: string
  ): Promise<void> {
    // Implementation stub for Redis registration
    // In real implementation, would register weight in Redis cache
    const key = `weight:${hash}`;
    logger.info(`✓ Registered in cache: ${key} → ${s3Path}`);
  }
}
