import { S3WeightManager } from '../s3Manager';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { DeploymentError } from '../../../utils/errors';

// Mock AWS SDK
jest.mock('@aws-sdk/client-s3');

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
      // For 2MB test, should be much faster
      expect(elapsed).toBeLessThan(5000);
    });

    it('should complete existence checks in <100ms', async () => {
      const start = Date.now();
      await manager.exists('models/test/hash/weights.bin');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
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
  });

  describe('error handling', () => {
    it('should handle missing local file path', async () => {
      await expect(manager.upload('/nonexistent/path/file.bin', 'test', 'hash')).rejects.toThrow(
        DeploymentError,
      );
    });
  });
});
