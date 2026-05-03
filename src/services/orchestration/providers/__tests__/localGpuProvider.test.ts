import { LocalGPUProvider } from '../localGpuProvider';
import { DeploymentError } from '../../../../utils/errors';

jest.mock('child_process');

describe('LocalGPUProvider', () => {
  let provider: LocalGPUProvider;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('connect', () => {
    it('should successfully connect with valid GPU output', async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});

      expect(execSync).toHaveBeenCalled();
    });

    it('should throw error when nvidia-smi fails', async () => {
      const { execSync } = require('child_process');
      execSync.mockImplementation(() => {
        throw new Error('nvidia-smi not found');
      });

      provider = new LocalGPUProvider();
      await expect(provider.connect({})).rejects.toThrow(DeploymentError);
    });

    it('should throw error when no GPUs detected', async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('');

      provider = new LocalGPUProvider();
      await expect(provider.connect({})).rejects.toThrow(DeploymentError);
    });
  });

  describe('listAvailable', () => {
    beforeEach(async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n1, RTX 4090, 24576 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});
    });

    it('should list available GPUs', async () => {
      const available = await provider.listAvailable();

      expect(available.length).toBe(2);
      expect(available[0]).toMatchObject({
        available: true,
        pricePerHour: 0,
      });
    });

    it('should throw when not connected', async () => {
      const disconnected = new LocalGPUProvider();
      await expect(disconnected.listAvailable()).rejects.toThrow(DeploymentError);
    });
  });

  describe('acquireGPU', () => {
    beforeEach(async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n1, RTX 4090, 24576 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});
    });

    it('should acquire GPU', async () => {
      const worker = await provider.acquireGPU({ minMemory: 40, framework: 'pytorch' });

      expect(worker.workerId).toBeDefined();
      expect(worker.status).toBe('ready');
      expect(worker.ipAddress).toBe('localhost');
    });

    it('should validate spec minMemory', async () => {
      await expect(
        provider.acquireGPU({ minMemory: -5, framework: 'pytorch' }),
      ).rejects.toThrow('minMemory must be greater than 0');
    });

    it('should validate spec framework', async () => {
      await expect(provider.acquireGPU({ minMemory: 40, framework: '' })).rejects.toThrow(
        'framework is required',
      );
    });

    it('should reject if no suitable GPU', async () => {
      await expect(
        provider.acquireGPU({ minMemory: 200, framework: 'pytorch' }),
      ).rejects.toThrow(DeploymentError);
    });
  });

  describe('releaseGPU', () => {
    beforeEach(async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});
    });

    it('should release GPU', async () => {
      const worker = await provider.acquireGPU({ minMemory: 40, framework: 'pytorch' });
      await provider.releaseGPU(worker.workerId);

      const available = await provider.listAvailable();
      expect(available[0].available).toBe(true);
    });

    it('should throw for unknown worker', async () => {
      await expect(provider.releaseGPU('unknown')).rejects.toThrow(DeploymentError);
    });
  });

  describe('getPrice', () => {
    beforeEach(async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});
    });

    it('should return 0 price', async () => {
      const price = await provider.getPrice('Tesla A100');
      expect(price).toBe(0);
    });
  });

  describe('healthCheck', () => {
    it('should return true when working', async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});

      execSync.mockReturnValue('0\n');
      const health = await provider.healthCheck();
      expect(health).toBe(true);
    });

    it('should return false on error', async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});

      execSync.mockImplementation(() => {
        throw new Error('failed');
      });
      const health = await provider.healthCheck();
      expect(health).toBe(false);
    });
  });

  describe('concurrent operations', () => {
    beforeEach(async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue(
        '0, Tesla A100, 81920 MB\n1, RTX 4090, 24576 MB\n2, A6000, 49152 MB\n',
      );

      provider = new LocalGPUProvider();
      await provider.connect({});
    });

    it('should acquire multiple GPUs', async () => {
      const w1 = await provider.acquireGPU({ minMemory: 10, framework: 'pytorch' });
      const w2 = await provider.acquireGPU({ minMemory: 10, framework: 'tensorflow' });
      const w3 = await provider.acquireGPU({ minMemory: 10, framework: 'jax' });

      expect(w1.workerId).not.toBe(w2.workerId);
      expect(w2.workerId).not.toBe(w3.workerId);

      const available = await provider.listAvailable();
      expect(available.every((g) => !g.available)).toBe(true);
    });
  });

  describe('performance', () => {
    beforeEach(async () => {
      const { execSync } = require('child_process');
      execSync.mockReturnValue('0, Tesla A100, 81920 MB\n');

      provider = new LocalGPUProvider();
      await provider.connect({});
    });

    it('should acquire GPU sub-10ms', async () => {
      const start = Date.now();
      await provider.acquireGPU({ minMemory: 40, framework: 'pytorch' });
      expect(Date.now() - start).toBeLessThan(10);
    });

    it('should release GPU sub-10ms', async () => {
      const worker = await provider.acquireGPU({ minMemory: 40, framework: 'pytorch' });
      const start = Date.now();
      await provider.releaseGPU(worker.workerId);
      expect(Date.now() - start).toBeLessThan(10);
    });
  });
});
