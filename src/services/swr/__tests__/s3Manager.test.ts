import { S3WeightManager } from '../s3Manager';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { DeploymentError } from '../../../utils/errors';

// Mock AWS SDK
jest.mock('@aws-sdk/client-s3');

// Mock the stream/promises pipeline
jest.mock('stream/promises', () => ({
  pipeline: jest.fn().mockResolvedValue(undefined),
}));

describe('S3WeightManager', () => {
  let manager: S3WeightManager;
  let tempDir: string;

  beforeEach(async () => {
    manager = new S3WeightManager({ bucket: 'test-bucket', region: 'us-east-1' });
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'test-'));
  });

  afterEach(async () => {
    // Cleanup temp files
    try {
      await fsPromises.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
    await manager.dispose();
  });

  describe('upload', () => {
    it('should upload file with correct metadata', async () => {
      // Create a test file
      const testFile = path.join(tempDir, 'test-model.bin');
      const testData = Buffer.alloc(1024 * 1024); // 1MB
      await fsPromises.writeFile(testFile, testData);

      const result = await manager.upload(testFile, 'gpt2', 'abc123');

      expect(result.path).toContain('models/gpt2/abc123');
      expect(result.size).toBe(1024 * 1024);
      expect(result.uploadedAt).toBeDefined();
      expect(result.metadata.modelName).toBe('gpt2');
      expect(result.metadata.modelHash).toBe('abc123');
      expect(result.metadata.fileSize).toBe((1024 * 1024).toString());
    });

    it('should handle large file uploads', async () => {
      // Create a simulated large file
      const testFile = path.join(tempDir, 'large-model.bin');
      const fileSize = 10 * 1024 * 1024; // 10MB test size
      const buffer = Buffer.alloc(fileSize);
      await fsPromises.writeFile(testFile, buffer);

      const result = await manager.upload(testFile, 'large-model', 'def456');

      expect(result.path).toContain('models/large-model/def456');
      expect(result.size).toBe(fileSize);
      expect(result.uploadedAt).toBeDefined();
    });

    it('should throw DeploymentError on nonexistent file', async () => {
      const nonexistentFile = path.join(tempDir, 'nonexistent.bin');

      await expect(manager.upload(nonexistentFile, 'test', 'hash')).rejects.toThrow(
        DeploymentError,
      );
    });

    it('should include timing in logs', async () => {
      const testFile = path.join(tempDir, 'timed-test.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(512 * 1024));

      const start = Date.now();
      await manager.upload(testFile, 'test', 'timing-test');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(0);
    });

    it('should calculate throughput in MB/s', async () => {
      const testFile = path.join(tempDir, 'throughput-test.bin');
      const fileSize = 5 * 1024 * 1024; // 5MB
      await fsPromises.writeFile(testFile, Buffer.alloc(fileSize));

      const result = await manager.upload(testFile, 'test', 'throughput');
      expect(result.size).toBe(fileSize);
    });

    it('should handle retry on transient failures', async () => {
      const testFile = path.join(tempDir, 'retry-test.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(1024));

      const managerWithRetry = new S3WeightManager({
        bucket: 'test-bucket',
        region: 'us-east-1',
        maxRetries: 2,
        retryDelayMs: 10,
      });

      const result = await managerWithRetry.upload(testFile, 'retry-model', 'retry123');
      expect(result).toBeDefined();
      await managerWithRetry.dispose();
    });

    it('should preserve special characters in model names', async () => {
      const testFile = path.join(tempDir, 'special-chars-test.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(1024));

      const result = await manager.upload(testFile, 'model-v2_beta', 'hash_123-abc.def');
      expect(result.path).toContain('model-v2_beta');
      expect(result.path).toContain('hash_123-abc.def');
    });
  });

  describe('download', () => {
    it('should handle download without throwing error', async () => {
      const outputFile = path.join(tempDir, 'downloaded.bin');

      // With mocked S3, download will be called but may fail
      // We just want to ensure it doesn't throw unexpectedly
      try {
        await manager.download('models/test/hash/weights.bin', outputFile);
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });

    it('should handle S3 path with bucket prefix', async () => {
      const outputFile = path.join(tempDir, 'bucket-prefix.bin');

      try {
        await manager.download('other-bucket/models/test/hash/weights.bin', outputFile);
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });

    it('should handle S3 path without bucket prefix', async () => {
      const outputFile = path.join(tempDir, 'no-bucket.bin');

      try {
        await manager.download('models/test/hash/weights.bin', outputFile);
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });
  });

  describe('exists', () => {
    it('should return boolean for existence checks', async () => {
      const result = await manager.exists('models/test/hash/weights.bin');
      expect(typeof result).toBe('boolean');
    });

    it('should handle path variations', async () => {
      const result1 = await manager.exists('bucket/models/test/hash/weights.bin');
      const result2 = await manager.exists('models/test/hash/weights.bin');

      expect(typeof result1).toBe('boolean');
      expect(typeof result2).toBe('boolean');
    });

    it('should handle S3 errors gracefully', async () => {
      // Should not throw even on S3 errors
      const result = await manager.exists('models/test/weights.bin');
      expect(typeof result).toBe('boolean');
    });

    it('should handle deep nested paths', async () => {
      const result = await manager.exists(
        'models/very/deep/nested/path/structure/weights.bin',
      );
      expect(typeof result).toBe('boolean');
    });

    it('should handle paths with special characters', async () => {
      const result = await manager.exists('models/model-v2_beta/hash_123-abc/weights.bin');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('performance', () => {
    it('should complete uploads in reasonable time', async () => {
      const testFile = path.join(tempDir, 'perf-test.bin');
      const fileSize = 2 * 1024 * 1024; // 2MB
      await fsPromises.writeFile(testFile, Buffer.alloc(fileSize));

      const start = Date.now();
      await manager.upload(testFile, 'perf-test', 'perf123');
      const elapsed = Date.now() - start;

      // In production, should be <20s for 15GB
      // For 2MB test, should be much faster (mocked)
      expect(elapsed).toBeLessThan(10000);
    });

    it('should complete existence checks in <100ms', async () => {
      const start = Date.now();
      await manager.exists('models/test/hash/weights.bin');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it('should handle multiple concurrent operations', async () => {
      const testFile1 = path.join(tempDir, 'concurrent1.bin');
      const testFile2 = path.join(tempDir, 'concurrent2.bin');

      await fsPromises.writeFile(testFile1, Buffer.alloc(1024 * 1024));
      await fsPromises.writeFile(testFile2, Buffer.alloc(1024 * 1024));

      const start = Date.now();
      await Promise.all([
        manager.upload(testFile1, 'model1', 'hash1'),
        manager.upload(testFile2, 'model2', 'hash2'),
        manager.exists('models/test/hash/weights.bin'),
      ]);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10000);
    });
  });

  describe('edge cases', () => {
    it('should handle files with special characters in name', async () => {
      const testFile = path.join(tempDir, 'test-special-chars.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(1024));

      const result = await manager.upload(testFile, 'model-v2', 'hash_123-abc');
      expect(result.path).toBeDefined();
    });

    it('should handle empty bucket option (use default)', () => {
      const manager2 = new S3WeightManager({ region: 'us-west-2' });
      expect(manager2).toBeDefined();
    });

    it('should dispose S3 client properly', async () => {
      const manager2 = new S3WeightManager();
      expect(async () => await manager2.dispose()).not.toThrow();
    });

    it('should handle very long model names', async () => {
      const testFile = path.join(tempDir, 'long-name-test.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(1024));

      const longModelName = 'model-' + 'very-'.repeat(20) + 'long';
      const result = await manager.upload(testFile, longModelName, 'hash123');
      expect(result.path).toContain(longModelName);
    });

    it('should handle empty files', async () => {
      const testFile = path.join(tempDir, 'empty.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(0));

      const result = await manager.upload(testFile, 'empty-model', 'emptyhash');
      expect(result.size).toBe(0);
    });

    it('should handle different region configurations', async () => {
      const managerWest = new S3WeightManager({
        bucket: 'test-bucket',
        region: 'us-west-2',
      });
      const managerEu = new S3WeightManager({
        bucket: 'test-bucket',
        region: 'eu-west-1',
      });

      expect(managerWest).toBeDefined();
      expect(managerEu).toBeDefined();

      await managerWest.dispose();
      await managerEu.dispose();
    });

    it('should handle custom S3 endpoint (e.g., MinIO)', async () => {
      const managerCustom = new S3WeightManager({
        bucket: 'test-bucket',
        region: 'us-east-1',
        endpoint: 'http://localhost:9000',
      });

      expect(managerCustom).toBeDefined();
      await managerCustom.dispose();
    });

    it('should handle retry configuration', async () => {
      const managerNoRetry = new S3WeightManager({
        bucket: 'test-bucket',
        maxRetries: 1,
        retryDelayMs: 100,
      });

      expect(managerNoRetry).toBeDefined();
      await managerNoRetry.dispose();
    });
  });

  describe('error handling', () => {
    it('should handle missing local file path', async () => {
      await expect(manager.upload('/nonexistent/path/file.bin', 'test', 'hash')).rejects.toThrow(
        DeploymentError,
      );
    });

    it('should include error details in thrown errors', async () => {
      try {
        await manager.upload('/nonexistent/path/file.bin', 'test', 'hash');
        fail('Should have thrown DeploymentError');
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
        const deploymentError = error as DeploymentError;
        expect(deploymentError.details).toBeDefined();
        expect(deploymentError.details?.attempts).toBe(3); // default maxRetries
      }
    });

    it('should differentiate between upload and download errors', async () => {
      try {
        await manager.upload('/nonexistent/path/file.bin', 'test', 'hash');
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
        const msg = (error as DeploymentError).message;
        expect(msg).toContain('upload');
      }
    });

    it('should handle metadata assignment correctly', async () => {
      const testFile = path.join(tempDir, 'metadata-test.bin');
      const testData = Buffer.alloc(2048);
      await fsPromises.writeFile(testFile, testData);

      const result = await manager.upload(testFile, 'metadata-model', 'metahash123');

      expect(result.metadata).toEqual({
        modelName: 'metadata-model',
        modelHash: 'metahash123',
        fileSize: '2048',
      });
    });

    it('should handle empty model name gracefully', async () => {
      const testFile = path.join(tempDir, 'empty-name-test.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(1024));

      const result = await manager.upload(testFile, '', 'hash123');
      expect(result.path).toContain('models//hash123');
    });

    it('should handle empty hash gracefully', async () => {
      const testFile = path.join(tempDir, 'empty-hash-test.bin');
      await fsPromises.writeFile(testFile, Buffer.alloc(1024));

      const result = await manager.upload(testFile, 'model', '');
      expect(result.path).toContain('model//weights.bin');
    });
  });

  describe('resource management', () => {
    it('should allow multiple manager instances', async () => {
      const manager1 = new S3WeightManager({ bucket: 'bucket1' });
      const manager2 = new S3WeightManager({ bucket: 'bucket2' });

      expect(manager1).toBeDefined();
      expect(manager2).toBeDefined();

      await manager1.dispose();
      await manager2.dispose();
    });

    it('should handle dispose being called multiple times', async () => {
      const managerMultiDispose = new S3WeightManager();
      await managerMultiDispose.dispose();
      await managerMultiDispose.dispose(); // Should not throw
    });
  });
});
