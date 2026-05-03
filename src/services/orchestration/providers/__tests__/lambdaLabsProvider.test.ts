import { LambdaLabsProvider } from '../lambdaLabsProvider';
import axios from 'axios';

jest.mock('axios');

describe('LambdaLabsProvider', () => {
  let provider: LambdaLabsProvider;
  const mockAxios = axios as jest.Mocked<typeof axios>;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new LambdaLabsProvider();
  });

  describe('connect', () => {
    it('should connect with valid credentials', async () => {
      const credentials = { api_key: 'test-api-key' };
      const mockCreate = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: { data: {} } }),
      });
      mockAxios.create = mockCreate;

      await provider.connect(credentials);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.lambdalabs.com/v1',
          headers: expect.objectContaining({ Authorization: expect.any(String) }),
        }),
      );
    });

    it('should throw error when api_key is missing', async () => {
      const credentials = {};

      await expect(provider.connect(credentials)).rejects.toThrow();
    });

    it('should throw error on API validation failure', async () => {
      const credentials = { api_key: 'invalid-key' };
      mockAxios.create = jest.fn().mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error('Unauthorized')),
      });

      await expect(provider.connect(credentials)).rejects.toThrow('connection failed');
    });
  });

  describe('listAvailable', () => {
    beforeEach(async () => {
      mockAxios.create = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: { data: {} } }),
      });
      await provider.connect({ api_key: 'test-key' });
    });

    it('should list available GPUs', async () => {
      const mockClient = mockAxios.create();
      (mockClient.get as jest.Mock).mockResolvedValue({
        data: {
          data: {
            'gpu_1_a100': {
              name: 'A100',
              gpu_count: 1,
              gpu_memory_gb: 40,
              description: 'A100 GPU',
              regions_with_capacity_available: [
                { region_name: 'us-east-1', cost_cents_per_hour: 500 },
              ],
            },
          },
        },
      });

      const available = await provider.listAvailable();

      expect(available).toHaveLength(1);
      expect(available[0]).toEqual(
        expect.objectContaining({
          gpuType: 'A100',
          memoryGB: 40,
          region: 'us-east-1',
          pricePerHour: 5,
        }),
      );
    });

    it('should throw error when not connected', async () => {
      const disconnected = new LambdaLabsProvider();

      await expect(disconnected.listAvailable()).rejects.toThrow('Not connected');
    });
  });

  describe('healthCheck', () => {
    it('should return true when connected', async () => {
      mockAxios.create = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ status: 200, data: { data: {} } }),
      });
      await provider.connect({ api_key: 'test-key' });

      const health = await provider.healthCheck();

      expect(health).toBe(true);
    });

    it('should return false on error', async () => {
      mockAxios.create = jest.fn().mockReturnValue({
        get: jest.fn()
          .mockResolvedValueOnce({ data: { data: {} } }) // for connect
          .mockRejectedValueOnce(new Error('Connection failed')), // for healthCheck
      });
      await provider.connect({ api_key: 'test-key' });

      const health = await provider.healthCheck();

      expect(health).toBe(false);
    });
  });

  describe('getPrice', () => {
    beforeEach(async () => {
      mockAxios.create = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({
          data: {
            data: {
              'gpu_1_a100': {
                name: 'A100',
                gpu_count: 1,
                gpu_memory_gb: 40,
                description: 'A100',
                regions_with_capacity_available: [
                  { region_name: 'us-east-1', cost_cents_per_hour: 500 },
                ],
              },
            },
          },
        }),
      });
      await provider.connect({ api_key: 'test-key' });
    });

    it('should get price for GPU type', async () => {
      const price = await provider.getPrice('A100', 'us-east-1');

      expect(price).toBe(5);
    });

    it('should return 0 for unknown GPU type', async () => {
      const price = await provider.getPrice('UnknownGPU');

      expect(price).toBe(0);
    });
  });

  describe('validation', () => {
    beforeEach(async () => {
      mockAxios.create = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({
          data: {
            data: {
              'gpu_1_a100': {
                name: 'A100',
                gpu_count: 1,
                gpu_memory_gb: 40,
                description: 'A100',
                regions_with_capacity_available: [
                  { region_name: 'us-east-1', cost_cents_per_hour: 500 },
                ],
              },
            },
          },
        }),
        post: jest.fn(),
      });
      await provider.connect({ api_key: 'test-key' });
    });

    it('should validate GPU spec - minMemory', async () => {
      const spec = { minMemory: -1, framework: 'pytorch' };

      await expect(provider.acquireGPU(spec)).rejects.toThrow('minMemory must be greater than 0');
    });

    it('should validate GPU spec - framework required', async () => {
      const spec = { minMemory: 30, framework: '' };

      await expect(provider.acquireGPU(spec)).rejects.toThrow('framework is required');
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      mockAxios.create = jest.fn().mockReturnValue({
        get: jest.fn(),
        post: jest.fn(),
      });
      await provider.connect({ api_key: 'test-key' });
    });

    it('should handle listAvailable API errors', async () => {
      const mockClient = mockAxios.create();
      (mockClient.get as jest.Mock).mockRejectedValue(new Error('API Error'));

      await expect(provider.listAvailable()).rejects.toThrow('Failed to list instances');
    });

    it('should handle acquireGPU when no matching GPU', async () => {
      const mockClient = mockAxios.create();
      (mockClient.get as jest.Mock).mockResolvedValue({
        data: { data: {} },
      });

      const spec = { minMemory: 500, framework: 'pytorch' };

      await expect(provider.acquireGPU(spec)).rejects.toThrow('No GPU available');
    });

    it('should handle releaseGPU for unknown worker', async () => {
      await expect(provider.releaseGPU('invalid-worker-id')).rejects.toThrow('Worker not found');
    });
  });
});
