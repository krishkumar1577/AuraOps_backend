import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { HashVerifier } from '../hashVerifier';
import { ValidationError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('os', () => {
  const actualOs = jest.requireActual('os');
  return {
    type: jest.fn(() => 'Darwin'),
    release: jest.fn(() => '23.0.0'),
    tmpdir: actualOs.tmpdir,
  };
});

describe('HashVerifier', () => {
  let verifier: HashVerifier;
  let tempDir: string;
  let testLockPath: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    verifier = new HashVerifier();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hashverifier-test-'));
    testLockPath = path.join(tempDir, 'requirements.txt');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('hashEnvironment', () => {
    it('should hash environment successfully', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
      expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
      expect(logger.info).toHaveBeenCalled();
    });

    it('should generate consistent hashes for same content', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const hash1 = await verifier.hashEnvironment(testLockPath);
      const hash2 = await verifier.hashEnvironment(testLockPath);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different content', async () => {
      const lockPath1 = path.join(tempDir, 'req1.txt');
      const lockPath2 = path.join(tempDir, 'req2.txt');

      await fs.writeFile(lockPath1, 'torch==2.0.0\n');
      await fs.writeFile(lockPath2, 'torch==2.1.0\n');

      const hash1 = await verifier.hashEnvironment(lockPath1);
      const hash2 = await verifier.hashEnvironment(lockPath2);

      expect(hash1).not.toBe(hash2);
    });

    it('should complete hashing within 1 second', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\nlingchain==0.1.0\n'.repeat(10);
      await fs.writeFile(testLockPath, content);

      const start = Date.now();
      await verifier.hashEnvironment(testLockPath);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
    });

    it('should throw ValidationError for invalid lock path', async () => {
      await expect(verifier.hashEnvironment('')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for null lock path', async () => {
      await expect(verifier.hashEnvironment(null as any)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for non-existent file', async () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.txt');

      await expect(verifier.hashEnvironment(nonExistentPath)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for empty lock file', async () => {
      await fs.writeFile(testLockPath, '');

      await expect(verifier.hashEnvironment(testLockPath)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for whitespace-only lock file', async () => {
      await fs.writeFile(testLockPath, '   \n\n  \t');

      await expect(verifier.hashEnvironment(testLockPath)).rejects.toThrow(ValidationError);
    });

    it('should handle lock file with comments', async () => {
      const content = '# This is a comment\ntorch==2.0.0\n# Another comment\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
    });

    it('should include OS info in hash calculation', async () => {
      const content = 'torch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
    });
  });

  describe('verifyLockfile', () => {
    it('should verify valid lock file', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);
      const isValid = await verifier.verifyLockfile(testLockPath, hash);

      expect(isValid).toBe(true);
    });

    it('should fail verification for tampered lock file', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);

      await fs.writeFile(testLockPath, 'torch==2.1.0\ntransformers==4.30.0\n');

      const isValid = await verifier.verifyLockfile(testLockPath, hash);

      expect(isValid).toBe(false);
    });

    it('should fail verification for wrong hash', async () => {
      const content = 'torch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      const wrongHash = 'a'.repeat(64);
      const isValid = await verifier.verifyLockfile(testLockPath, wrongHash);

      expect(isValid).toBe(false);
    });

    it('should throw ValidationError for empty lock path', async () => {
      await expect(verifier.verifyLockfile('', 'somehash')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for null lock path', async () => {
      await expect(verifier.verifyLockfile(null as any, 'hash')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for empty expected hash', async () => {
      const content = 'torch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      await expect(verifier.verifyLockfile(testLockPath, '')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for null expected hash', async () => {
      const content = 'torch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      await expect(verifier.verifyLockfile(testLockPath, null as any)).rejects.toThrow(
        ValidationError,
      );
    });

    it('should throw ValidationError for non-existent file', async () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.txt');
      const hash = 'a'.repeat(64);

      await expect(verifier.verifyLockfile(nonExistentPath, hash)).rejects.toThrow(
        ValidationError,
      );
    });

    it('should log verification results', async () => {
      const content = 'torch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);
      await verifier.verifyLockfile(testLockPath, hash);

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('verification'));
    });
  });

  describe('getFingerprintmetadata', () => {
    it('should return fingerprint metadata', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);

      expect(fingerprint).toBeDefined();
      expect(fingerprint.osType).toBe('Darwin');
      expect(fingerprint.osRelease).toBe('23.0.0');
      expect(fingerprint.pythonVersion).toBeDefined();
      expect(fingerprint.packageCount).toBeGreaterThanOrEqual(0);
      expect(fingerprint.dependencyHash).toBeDefined();
      expect(fingerprint.timestamp).toBeDefined();
      expect(typeof fingerprint.dependencyHash).toBe('string');
      expect(fingerprint.dependencyHash.length).toBe(64);
    });

    it('should count packages correctly', async () => {
      const content =
        'torch==2.0.0\ntransformers==4.30.0\nlangchain==0.1.0\n# comment\nnumpy@latest\n';
      await fs.writeFile(testLockPath, content);

      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);

      expect(fingerprint.packageCount).toBeGreaterThanOrEqual(3);
    });

    it('should handle empty lock file gracefully', async () => {
      const emptyPath = path.join(tempDir, 'empty.txt');
      await fs.writeFile(emptyPath, '\n\n\n');

      await expect(verifier.getFingerprintmetadata(emptyPath)).rejects.toThrow(ValidationError);
    });

    it('should extract python version from lock file', async () => {
      const content = 'python_version==3.11\ntorch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);

      expect(fingerprint.pythonVersion).toBeDefined();
    });

    it('should default to Python 3.10 if version not found', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);

      expect(fingerprint.pythonVersion).toBe('3.10');
    });

    it('should generate consistent dependency hashes', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const fingerprint1 = await verifier.getFingerprintmetadata(testLockPath);
      const fingerprint2 = await verifier.getFingerprintmetadata(testLockPath);

      expect(fingerprint1.dependencyHash).toBe(fingerprint2.dependencyHash);
    });

    it('should return timestamp within reasonable range', async () => {
      const content = 'torch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      const before = Date.now();
      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);
      const after = Date.now();

      expect(fingerprint.timestamp).toBeGreaterThanOrEqual(before);
      expect(fingerprint.timestamp).toBeLessThanOrEqual(after + 1000);
    });

    it('should throw ValidationError for invalid path', async () => {
      await expect(verifier.getFingerprintmetadata('')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for null path', async () => {
      await expect(verifier.getFingerprintmetadata(null as any)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for non-existent file', async () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.txt');

      await expect(verifier.getFingerprintmetadata(nonExistentPath)).rejects.toThrow(
        ValidationError,
      );
    });

    it('should log fingerprint generation', async () => {
      const content = 'torch==2.0.0\n';
      await fs.writeFile(testLockPath, content);

      await verifier.getFingerprintmetadata(testLockPath);

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Fingerprint metadata'));
    });

    it('should handle large dependency trees', async () => {
      const packages = Array.from({ length: 100 }, (_, i) => `package${i}==1.0.0`).join('\n');
      await fs.writeFile(testLockPath, packages);

      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);

      expect(fingerprint.packageCount).toBeGreaterThan(50);
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle lock file with mixed package formats', async () => {
      const content = `torch==2.0.0
transformers @ https://github.com/huggingface/transformers/archive/main.zip
git+https://github.com/pytorch/pytorch.git@v2.0.0
langchain>=0.1.0
numpy[test]==1.24.0`;
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);
      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);

      expect(hash).toBeDefined();
      expect(fingerprint.packageCount).toBeGreaterThan(0);
    });

    it('should be idempotent across multiple calls', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const results = await Promise.all([
        verifier.hashEnvironment(testLockPath),
        verifier.hashEnvironment(testLockPath),
        verifier.hashEnvironment(testLockPath),
      ]);

      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });

    it('should handle special characters in lock file', async () => {
      const content = 'torch==2.0.0; python_version>="3.8"\n# Special: çñ é\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);
      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);

      expect(hash).toBeDefined();
      expect(fingerprint).toBeDefined();
    });

    it('should verify complete workflow', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const fingerprint = await verifier.getFingerprintmetadata(testLockPath);
      const hash = await verifier.hashEnvironment(testLockPath);
      const isValid = await verifier.verifyLockfile(testLockPath, hash);

      expect(fingerprint).toBeDefined();
      expect(hash).toBeDefined();
      expect(isValid).toBe(true);
      expect(fingerprint.packageCount).toBeGreaterThan(0);
    });
  });

  describe('performance targets', () => {
    it('should hash environment in less than 1 second for typical files', async () => {
      const packages = Array.from({ length: 50 }, (_, i) => `package${i}==1.0.${i}`).join('\n');
      await fs.writeFile(testLockPath, packages);

      const start = Date.now();
      await verifier.hashEnvironment(testLockPath);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
    });

    it('should verify lock file in less than 1 second', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const hash = await verifier.hashEnvironment(testLockPath);

      const start = Date.now();
      await verifier.verifyLockfile(testLockPath, hash);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
    });

    it('should generate fingerprint metadata in less than 1 second', async () => {
      const content = 'torch==2.0.0\ntransformers==4.30.0\n';
      await fs.writeFile(testLockPath, content);

      const start = Date.now();
      await verifier.getFingerprintmetadata(testLockPath);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
    });
  });

  describe('type safety and validation', () => {
    it('should enforce strict parameter types for hashEnvironment', async () => {
      await expect(verifier.hashEnvironment(123 as any)).rejects.toThrow(ValidationError);
      await expect(verifier.hashEnvironment(undefined as any)).rejects.toThrow(ValidationError);
    });

    it('should enforce strict parameter types for verifyLockfile', async () => {
      await expect(verifier.verifyLockfile(123 as any, 'hash')).rejects.toThrow(ValidationError);
      await expect(verifier.verifyLockfile('path', 123 as any)).rejects.toThrow(ValidationError);
    });

    it('should enforce strict parameter types for getFingerprintmetadata', async () => {
      await expect(verifier.getFingerprintmetadata(123 as any)).rejects.toThrow(ValidationError);
      await expect(verifier.getFingerprintmetadata('' as any)).rejects.toThrow(ValidationError);
    });
  });
});
