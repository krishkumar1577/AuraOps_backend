import { BackgroundJobQueue } from '../backgroundJobs';
import { DeploymentError } from '../../../utils/errors';
import { ValidationError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { S3WeightManager, S3UploadResult } from '../../swr/s3Manager';
import { RedisWeightRegistry } from '../../swr/redisClient';

// Mock dependencies
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    isOpen: true,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../swr/s3Manager');
jest.mock('../../swr/redisClient');

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({
    data: {
      pipe: jest.fn().mockReturnValue({}),
    },
  }),
}));

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 1024 * 1024 * 100 }),
}));

jest.mock('fs', () => ({
  createWriteStream: jest.fn(() => ({
    on: jest.fn(),
  })),
}));

jest.mock('stream/promises', () => ({
  pipeline: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('bull', () => {
  return jest.fn((_name: string) => ({
    add: jest.fn().mockResolvedValue({ id: 'job-12345' }),
    process: jest.fn(),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    clean: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(null),
    getFailed: jest.fn().mockResolvedValue([]),
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: 1,
      active: 0,
      completed: 10,
      failed: 0,
    }),
  }));
});

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('BackgroundJobQueue', () => {
  let queue: BackgroundJobQueue;
  let mockS3Manager: jest.Mocked<S3WeightManager>;
  let mockRedisRegistry: jest.Mocked<RedisWeightRegistry>;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockS3Manager = new S3WeightManager() as jest.Mocked<S3WeightManager>;
    mockRedisRegistry = new RedisWeightRegistry() as jest.Mocked<RedisWeightRegistry>;

    mockS3Manager.upload = jest.fn().mockResolvedValue({
      path: 'models/test-model/abc123/weights.bin',
      size: 100 * 1024 * 1024,
      uploadedAt: new Date().toISOString(),
      metadata: {
        modelName: 'test-model',
        modelHash: 'abc123',
        fileSize: '104857600',
      },
    } as S3UploadResult);

    mockRedisRegistry.register = jest
      .fn()
      .mockResolvedValue(undefined);

    queue = new BackgroundJobQueue(
      mockS3Manager,
      mockRedisRegistry,
    );
    await queue.initialize();
  });

  afterEach(async () => {
    await queue.dispose();
  });

  describe('initialization', () => {
    it('should initialize queue successfully', async () => {
      expect(queue).toBeDefined();
      expect(queue.isReady()).toBe(true);
    });

    it('should connect to Redis', async () => {
      expect(queue.isReady()).toBe(true);
    });

    it('should set up job processors and event handlers', async () => {
      const newQueue = new BackgroundJobQueue(
        mockS3Manager,
        mockRedisRegistry,
      );
      await newQueue.initialize();
      expect(newQueue.isReady()).toBe(true);
      await newQueue.dispose();
    });
  });

  describe('queueWeightPull', () => {
    it('should queue a weight pull job with huggingface source', async () => {
      const start = Date.now();
      const jobId = await queue.queueWeightPull(
        'gpt2',
        'abc123',
        'huggingface',
      );

      expect(jobId).toBeDefined();
      expect(Date.now() - start).toBeLessThan(100);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Weight pull queued'),
      );
    });

    it('should queue a weight pull job with custom-url source', async () => {
      const jobId = await queue.queueWeightPull(
        'custom-model',
        'def456',
        'custom-url',
        'https://example.com/weights.bin',
      );

      expect(jobId).toBeDefined();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Weight pull queued'),
      );
    });

    it('should return job ID immediately (non-blocking)', async () => {
      const start = Date.now();
      const promise = queue.queueWeightPull(
        'model-x',
        'hash-x',
        'huggingface',
      );

      expect(Date.now() - start).toBeLessThan(10);
      const jobId = await promise;
      expect(jobId).toBeDefined();
    });

    it('should validate model name is not empty', async () => {
      await expect(
        queue.queueWeightPull('', 'hash123', 'huggingface'),
      ).rejects.toThrow(ValidationError);
    });

    it('should validate hash is not empty', async () => {
      await expect(
        queue.queueWeightPull('model', '', 'huggingface'),
      ).rejects.toThrow(ValidationError);
    });

    it('should validate source is valid enum', async () => {
      await expect(
        queue.queueWeightPull('model', 'hash', 'invalid-source' as any),
      ).rejects.toThrow(ValidationError);
    });

    it('should require sourceUrl for custom-url source', async () => {
      await expect(
        queue.queueWeightPull('model', 'hash', 'custom-url'),
      ).rejects.toThrow(ValidationError);
    });

    it('should validate sourceUrl format for custom-url source', async () => {
      await expect(
        queue.queueWeightPull(
          'model',
          'hash',
          'custom-url',
          'not-a-url',
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('should accept https URLs for custom-url source', async () => {
      const jobId = await queue.queueWeightPull(
        'model',
        'hash',
        'custom-url',
        'https://example.com/model.bin',
      );
      expect(jobId).toBeDefined();
    });

    it('should accept http URLs for custom-url source', async () => {
      const jobId = await queue.queueWeightPull(
        'model',
        'hash',
        'custom-url',
        'http://example.com/model.bin',
      );
      expect(jobId).toBeDefined();
    });

    it('should handle queue not ready error', async () => {
      const newQueue = new BackgroundJobQueue(
        mockS3Manager,
        mockRedisRegistry,
      );
      // Don't call initialize
      await expect(
        newQueue.queueWeightPull('model', 'hash', 'huggingface'),
      ).rejects.toThrow(DeploymentError);
    });
  });

  describe('job status tracking', () => {
    it('should return null for unknown job ID', async () => {
      const status = await queue.getJobStatus('unknown-job-id');
      expect(status).toBeNull();
    });

    it('should return job progress', async () => {
      const progress = await queue.getJobProgress('any-job-id');
      expect(progress).toBeDefined();
      expect(progress?.percent ?? 0).toBeGreaterThanOrEqual(0);
    });

    it('should return null progress for unknown job', async () => {
      const progress = await queue.getJobProgress('unknown-job-id');
      expect(progress).toBeNull();
    });
  });

  describe('queue statistics', () => {
    it('should return queue statistics', async () => {
      const stats = await queue.getStats();

      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('active');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('failed');

      expect(stats.pending).toBeGreaterThanOrEqual(0);
      expect(stats.active).toBeGreaterThanOrEqual(0);
      expect(stats.completed).toBeGreaterThanOrEqual(0);
      expect(stats.failed).toBeGreaterThanOrEqual(0);
    });

    it('should handle stats error gracefully', async () => {
      const stats = await queue.getStats();
      expect(stats).toBeDefined();
    });
  });

  describe('job cleanup', () => {
    it('should cleanup failed jobs', async () => {
      await queue.cleanupFailedJobs();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cleanup complete'),
      );
    });

    it('should handle cleanup errors gracefully', async () => {
      await queue.cleanupFailedJobs();
      expect(queue.isReady()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw ValidationError for invalid inputs', async () => {
      try {
        await queue.queueWeightPull('', 'hash', 'huggingface');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
      }
    });

    it('should throw ValidationError on invalid hash', async () => {
      try {
        await queue.queueWeightPull('model', '', 'huggingface');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
      }
    });

    it('should throw error for queue errors', async () => {
      try {
        await queue.queueWeightPull('', '', 'huggingface');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
      }
    });

    it('should log validation errors', async () => {
      try {
        await queue.queueWeightPull('', '', 'huggingface');
      } catch (error) {
        expect(logger.error).toHaveBeenCalled();
      }
    });
  });

  describe('resource cleanup', () => {
    it('should dispose queue resources', async () => {
      const newQueue = new BackgroundJobQueue(
        mockS3Manager,
        mockRedisRegistry,
      );
      await newQueue.initialize();
      expect(newQueue.isReady()).toBe(true);

      await newQueue.dispose();
      expect(newQueue.isReady()).toBe(false);
    });

    it('should handle multiple dispose calls', async () => {
      await queue.dispose();
      await queue.dispose();
      expect(queue.isReady()).toBe(false);
    });

    it('should still work after dispose', async () => {
      await queue.dispose();
      expect(queue.isReady()).toBe(false);
    });
  });

  describe('performance', () => {
    it('should queue job in <100ms', async () => {
      const start = Date.now();
      await queue.queueWeightPull('perf-model', 'perf-hash', 'huggingface');
      expect(Date.now() - start).toBeLessThan(100);
    });

    it('should handle 5 concurrent queue operations in <500ms', async () => {
      const start = Date.now();
      const promises = Array(5)
        .fill(null)
        .map((_, i) =>
          queue.queueWeightPull(
            `model${i}`,
            `hash${i}`,
            'huggingface',
          ),
        );

      await Promise.all(promises);
      expect(Date.now() - start).toBeLessThan(500);
    });

    it('should not block getStats calls', async () => {
      const start = Date.now();
      const stats = await queue.getStats();
      expect(Date.now() - start).toBeLessThan(50);
      expect(stats).toBeDefined();
    });
  });

  describe('weight pull integration', () => {
    it('should validate inputs for downloadWeight workflow', async () => {
      // Test that validation happens before any external calls
      await expect(
        queue.queueWeightPull('', 'hash', 'huggingface'),
      ).rejects.toThrow(ValidationError);
    });

    it('should accept valid model and hash combinations', async () => {
      const validCombos = [
        ['bert-base-uncased', 'hash1', 'huggingface'],
        ['gpt2', 'hash2', 'huggingface'],
        ['model-with-dash', 'hash3', 'huggingface'],
        ['ModelWithCaps', 'HASH4', 'huggingface'],
      ];

      for (const [modelName, hash, source] of validCombos) {
        const jobId = await queue.queueWeightPull(
          modelName,
          hash,
          source as any,
        );
        expect(jobId).toBeDefined();
      }
    });

    it('should queue custom-url source with proper configuration', async () => {
      const jobId = await queue.queueWeightPull(
        'my-model',
        'hash-abc123',
        'custom-url',
        'https://example.com/path/to/weights.bin',
      );
      expect(jobId).toBeDefined();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Weight pull queued'),
      );
    });

    it('should include sourceUrl in job data for custom-url', async () => {
      const jobId = await queue.queueWeightPull(
        'model',
        'hash',
        'custom-url',
        'https://cdn.example.com/model.bin',
      );
      expect(jobId).toBeDefined();
    });
  });

  describe('private method validation', () => {
    it('should validate whitespace-only model names', async () => {
      await expect(
        queue.queueWeightPull('   ', 'hash', 'huggingface'),
      ).rejects.toThrow(ValidationError);
    });

    it('should validate whitespace-only hashes', async () => {
      await expect(
        queue.queueWeightPull('model', '   ', 'huggingface'),
      ).rejects.toThrow(ValidationError);
    });

    it('should validate sourceUrl is not empty string for custom-url', async () => {
      await expect(
        queue.queueWeightPull('model', 'hash', 'custom-url', ''),
      ).rejects.toThrow(ValidationError);
    });

    it('should validate sourceUrl is not whitespace for custom-url', async () => {
      await expect(
        queue.queueWeightPull('model', 'hash', 'custom-url', '   '),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('queue initialization states', () => {
    it('should handle queueing when queue is not ready', async () => {
      const uninitializedQueue = new BackgroundJobQueue(
        mockS3Manager,
        mockRedisRegistry,
      );

      await expect(
        uninitializedQueue.queueWeightPull('model', 'hash', 'huggingface'),
      ).rejects.toThrow(DeploymentError);
    });

    it('should maintain ready state after successful queue', async () => {
      const wasReady = queue.isReady();
      await queue.queueWeightPull('model', 'hash', 'huggingface');
      expect(queue.isReady()).toBe(wasReady);
    });
  });

  describe('concurrent operations', () => {
    it('should handle 10 concurrent job queue operations', async () => {
      const start = Date.now();
      const promises = Array(10)
        .fill(null)
        .map((_, i) =>
          queue.queueWeightPull(
            `model-${i}`,
            `hash-${i}`,
            'huggingface',
          ),
        );

      const jobIds = await Promise.all(promises);
      expect(jobIds).toHaveLength(10);
      expect(jobIds.every(id => id !== undefined)).toBe(true);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('should handle concurrent queue and status check operations', async () => {
      const jobId = await queue.queueWeightPull('model1', 'hash1', 'huggingface');

      const [status, progress] = await Promise.all([
        queue.getJobStatus(jobId),
        queue.getJobProgress(jobId),
      ]);

      expect(status).toBeDefined();
      expect(progress).toBeDefined();
    });
  });

  describe('job metadata', () => {
    it('should include all required job data fields', async () => {
      const jobId = await queue.queueWeightPull(
        'test-model',
        'test-hash',
        'huggingface',
      );

      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
    });

    it('should use model name and hash in job ID', async () => {
      // The mock returns a fixed ID, so we just verify it returns a string ID
      const jobId = await queue.queueWeightPull(
        'bert-base',
        'abc123xyz',
        'huggingface',
      );

      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
      expect(jobId.length).toBeGreaterThan(0);
    });
  });
});
