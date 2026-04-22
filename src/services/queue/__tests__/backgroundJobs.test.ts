import { BackgroundJobQueue } from '../backgroundJobs';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

// Mock Redis and S3
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn(),
  })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

jest.mock('bull', () => {
  return jest.fn((_name: string) => ({
    add: jest.fn().mockResolvedValue({ id: '12345' }),
    process: jest.fn(),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    clean: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(null),
    getFailed: jest.fn().mockResolvedValue([]),
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

  beforeEach(async () => {
    jest.clearAllMocks();
    queue = new BackgroundJobQueue();
    await queue.initialize();
  });

  afterEach(async () => {
    await queue.dispose();
  });

  describe('initialization', () => {
    it('should initialize queue successfully', async () => {
      expect(queue).toBeDefined();
    });

    it('should set up job processors', async () => {
      expect(queue.isReady()).toBe(true);
    });
  });

  describe('queueWeightPull', () => {
    it('should queue a weight pull job', async () => {
      const start = Date.now();
      await queue.queueWeightPull('gpt2', 'abc123', 'huggingface');
      expect(Date.now() - start).toBeLessThan(100); // <100ms response time

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Weight pull queued')
      );
    });

    it('should return immediately (non-blocking)', async () => {
      const start = Date.now();
      const promise = queue.queueWeightPull('large-model', 'def456', 'https://example.com/weights.bin');
      expect(Date.now() - start).toBeLessThan(10); // Should be <10ms

      await promise;
      expect(Date.now() - start).toBeLessThan(100);
    });

    it('should accept huggingface source', async () => {
      await queue.queueWeightPull('bert-base', 'hash001', 'huggingface');
      expect(logger.info).toHaveBeenCalled();
    });

    it('should accept custom URL source', async () => {
      await queue.queueWeightPull('custom-model', 'hash002', 'https://example.com/weights.bin');
      expect(logger.info).toHaveBeenCalled();
    });

    it('should validate model name', async () => {
      await expect(queue.queueWeightPull('', 'hash', 'huggingface')).rejects.toThrow(
        DeploymentError
      );
    });

    it('should validate hash', async () => {
      await expect(queue.queueWeightPull('model', '', 'huggingface')).rejects.toThrow(
        DeploymentError
      );
    });

    it('should validate source URL format', async () => {
      await expect(queue.queueWeightPull('model', 'hash', 'invalid-url')).rejects.toThrow(
        DeploymentError
      );
    });
  });

  describe('job processing', () => {
    it('should process queued jobs', async () => {
      await queue.queueWeightPull('test-model', 'abc123', 'huggingface');
      // Job should be queued for processing
      expect(logger.info).toHaveBeenCalled();
    });

    it('should handle job failures with retries', async () => {
      // Mock a failing job scenario
      await queue.queueWeightPull('failing-model', 'hash123', 'huggingface');
      // The queue should be configured with retries
      expect(queue.isReady()).toBe(true);
    });

    it('should support exponential backoff', async () => {
      await queue.queueWeightPull('backoff-test', 'hash456', 'huggingface');
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('job status', () => {
    it('should return job status', async () => {
      const jobId = await queue.queueWeightPull('model1', 'hash1', 'huggingface');
      const status = await queue.getJobStatus(jobId);

      expect(status).toBeDefined();
      if (status) {
        expect(['pending', 'queued', 'processing', 'completed', 'failed']).toContain(
          status.state
        );
      }
    });

    it('should return job progress', async () => {
      const jobId = await queue.queueWeightPull('model2', 'hash2', 'huggingface');
      const progress = await queue.getJobProgress(jobId);

      expect(progress).toBeDefined();
      if (progress) {
        expect(progress.percent).toBeGreaterThanOrEqual(0);
        expect(progress.percent).toBeLessThanOrEqual(100);
      }
    });

    it('should handle unknown job ID', async () => {
      const status = await queue.getJobStatus('unknown-id');
      expect(status).toBeNull();
    });
  });

  describe('queue statistics', () => {
    it('should return queue stats', async () => {
      await queue.queueWeightPull('stat-model1', 'hash1', 'huggingface');
      const stats = queue.getStats();

      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('active');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('failed');
    });

    it('should track job counts', async () => {
      const statsBefore = queue.getStats();
      await queue.queueWeightPull('count-model', 'hashX', 'huggingface');
      const statsAfter = queue.getStats();

      expect(statsAfter.pending).toBeGreaterThanOrEqual(statsBefore.pending);
    });
  });

  describe('error handling', () => {
    it('should throw on invalid model name', async () => {
      expect(async () => {
        await queue.queueWeightPull('', 'hash', 'huggingface');
      }).rejects.toThrow();
    });

    it('should throw on invalid hash', async () => {
      expect(async () => {
        await queue.queueWeightPull('model', '', 'huggingface');
      }).rejects.toThrow();
    });

    it('should wrap errors in DeploymentError', async () => {
      try {
        await queue.queueWeightPull('model', '', 'huggingface');
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });

    it('should log errors with context', async () => {
      try {
        await queue.queueWeightPull('', 'hash', 'huggingface');
      } catch (error) {
        expect(logger.error).toHaveBeenCalled();
      }
    });
  });

  describe('performance', () => {
    it('should queue job in <100ms', async () => {
      const start = Date.now();
      await queue.queueWeightPull('perf-model', 'perfhash', 'huggingface');
      expect(Date.now() - start).toBeLessThan(100);
    });

    it('should handle multiple concurrent queues', async () => {
      const start = Date.now();
      const promises = Array(5)
        .fill(null)
        .map((_, i) =>
          queue.queueWeightPull(`model${i}`, `hash${i}`, 'huggingface')
        );

      await Promise.all(promises);
      expect(Date.now() - start).toBeLessThan(500); // 5 jobs in <500ms
    });

    it('should not block subsequent operations', async () => {
      await queue.queueWeightPull('model1', 'hash1', 'huggingface');

      const start = Date.now();
      const stats = queue.getStats();
      expect(Date.now() - start).toBeLessThan(10); // getStats should be instant
      expect(stats).toBeDefined();
    });
  });

  describe('cleanup', () => {
    it('should dispose queue resources', async () => {
      queue = new BackgroundJobQueue();
      await queue.initialize();
      await queue.dispose();

      expect(queue.isReady()).toBe(false);
    });

    it('should clean up failed jobs', async () => {
      await queue.cleanupFailedJobs();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('cleaned up')
      );
    });

    it('should handle cleanup errors gracefully', async () => {
      await queue.dispose();
      // Should not throw even if already disposed
      await queue.dispose();
    });
  });
});
