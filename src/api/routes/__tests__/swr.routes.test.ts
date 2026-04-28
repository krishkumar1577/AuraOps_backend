import { registerSWRRoutes, cleanupSWRServices } from '../swr.routes';

// Mock services
jest.mock('../../../services/swr/redisClient', () => ({
  RedisWeightRegistry: jest.fn(() => ({
    lookup: jest.fn().mockResolvedValue({
      modelHash: 'abc123def456',
      framework: 'pytorch',
      sizeGB: 15.5,
      storagePath: 's3://auraops-weights/llama-2-7b',
      mountPoint: '/models/llama-2-7b',
      lastAccessed: Date.now(),
      cacheHits: 42,
      ttlSeconds: 2592000,
    }),
    stats: jest.fn().mockResolvedValue({
      totalWeights: 3,
      totalSizeGB: 45.5,
      cacheHitRate: 0.87,
    }),
    register: jest.fn().mockResolvedValue(undefined),
    evictLRU: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../services/queue/backgroundJobs', () => ({
  BackgroundJobQueue: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    queueWeightPull: jest.fn().mockResolvedValue('job-xyz-123'),
    getJobStatus: jest.fn().mockResolvedValue({
      id: 'job-xyz-123',
      state: 'processing',
      progress: 50,
    }),
    getJobProgress: jest.fn().mockResolvedValue({
      percent: 50,
      bytes: 5000000000,
    }),
    dispose: jest.fn().mockResolvedValue(undefined),
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('SWR API Routes', () => {
  let mockFastify: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock Fastify instance
    mockFastify = {
      get: jest.fn(),
      post: jest.fn(),
    };
  });

  afterEach(async () => {
    await cleanupSWRServices();
  });

  describe('Route Registration', () => {
    it('should register all 4 SWR routes', async () => {
      await registerSWRRoutes(mockFastify);

      expect(mockFastify.get).toHaveBeenCalledWith(
        '/api/v1/weights',
        expect.any(Function)
      );
      expect(mockFastify.get).toHaveBeenCalledWith(
        '/api/v1/weights/:hash',
        expect.any(Function)
      );
      expect(mockFastify.post).toHaveBeenCalledWith(
        '/api/v1/weights/pull',
        expect.any(Function)
      );
      expect(mockFastify.get).toHaveBeenCalledWith(
        '/api/v1/weights/stats',
        expect.any(Function)
      );
    });

    it('should register exactly 4 routes', async () => {
      await registerSWRRoutes(mockFastify);

      const totalCalls = mockFastify.get.mock.calls.length + mockFastify.post.mock.calls.length;
      expect(totalCalls).toBe(4);
    });
  });

  describe('GET /api/v1/weights', () => {
    it('should return list with 200 status', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalled();
    });

    it('should return proper response structure', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse).toHaveProperty('weights');
      expect(sentResponse).toHaveProperty('totalCount');
      expect(sentResponse).toHaveProperty('timing');
      expect(Array.isArray(sentResponse.weights)).toBe(true);
      expect(typeof sentResponse.totalCount).toBe('number');
      expect(typeof sentResponse.timing).toBe('string');
    });

    it('should include timing information', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.timing).toMatch(/^\d+ms$/);
    });

    it('should handle errors gracefully', async () => {
      const { RedisWeightRegistry } = require('../../../services/swr/redisClient');
      RedisWeightRegistry.mockImplementationOnce(() => ({
        stats: jest.fn().mockRejectedValueOnce(new Error('Redis connection failed')),
      }));

      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.success).toBe(false);
      expect(sentResponse.error).toBeDefined();
    });
  });

  describe('GET /api/v1/weights/:hash', () => {
    it('should return weight with 200 status for valid hash', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: 'abc123def456' },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalled();
    });

    it('should return proper response structure for weight', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: 'abc123def456' },
      };

      await handler(request as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse).toHaveProperty('weight');
      expect(sentResponse).toHaveProperty('timing');
      expect(sentResponse.weight).toHaveProperty('modelHash');
      expect(sentResponse.weight).toHaveProperty('sizeGB');
      expect(sentResponse.weight).toHaveProperty('storagePath');
    });

    it('should return 400 for empty hash', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: '' },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.success).toBe(false);
      expect(sentResponse.error).toContain('required');
    });

    it('should return 400 for whitespace-only hash', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: '   ' },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
    });

    it('should return 404 when weight not found', async () => {
      const { RedisWeightRegistry } = require('../../../services/swr/redisClient');
      RedisWeightRegistry.mockImplementationOnce(() => ({
        lookup: jest.fn().mockResolvedValueOnce(null),
        stats: jest.fn().mockResolvedValueOnce({
          totalWeights: 0,
          totalSizeGB: 0,
          cacheHitRate: 0,
        }),
      }));

      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: 'unknown-hash' },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(404);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.success).toBe(false);
      expect(sentResponse.error).toContain('not found');
    });

    it('should include timing in response', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: 'abc123' },
      };

      await handler(request as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.timing).toMatch(/^\d+ms$/);
    });

    it('should handle Redis errors', async () => {
      const { RedisWeightRegistry } = require('../../../services/swr/redisClient');
      RedisWeightRegistry.mockImplementationOnce(() => ({
        lookup: jest.fn().mockRejectedValueOnce(new Error('Redis connection lost')),
        stats: jest.fn().mockResolvedValueOnce({
          totalWeights: 0,
          totalSizeGB: 0,
          cacheHitRate: 0,
        }),
      }));

      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: 'abc123' },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.success).toBe(false);
    });
  });

  describe('POST /api/v1/weights/pull', () => {
    it('should queue weight pull with 202 status', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'meta-llama/Llama-2-7b-hf',
          modelHash: 'abc123def456',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(202);
      expect(mockReply.send).toHaveBeenCalled();
    });

    it('should return proper response structure for pull', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'bert-base-uncased',
          modelHash: 'hash1234',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse).toHaveProperty('success', true);
      expect(sentResponse).toHaveProperty('jobId');
      expect(sentResponse).toHaveProperty('status', 'queued');
      expect(sentResponse).toHaveProperty('eta');
      expect(sentResponse).toHaveProperty('timing');
    });

    it('should accept huggingface source', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'gpt2',
          modelHash: 'hash5678',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(202);
    });

    it('should accept https URL source', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'custom-model',
          modelHash: 'hash9999',
          source: 'https://example.com/weights.bin',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(202);
    });

    it('should accept http URL source', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'another-model',
          modelHash: 'hashABCD',
          source: 'http://example.com/model.bin',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(202);
    });

    it('should return 400 for missing modelName', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: '',
          modelHash: 'hash',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.success).toBe(false);
    });

    it('should return 400 for missing modelHash', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'test-model',
          modelHash: '',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing source', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'test-model',
          modelHash: 'hash123',
          source: '',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
    });

    it('should return 400 for invalid source', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'test-model',
          modelHash: 'hash123',
          source: 'invalid-source-format',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.error).toContain('Validation failed');
    });

    it('should validate all required fields', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {},
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
    });

    it('should include timing in response', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'test',
          modelHash: 'hash',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.timing).toMatch(/^\d+ms$/);
    });

    it('should handle queue errors', async () => {
      const { BackgroundJobQueue } = require('../../../services/queue/backgroundJobs');
      BackgroundJobQueue.mockImplementationOnce(() => ({
        initialize: jest.fn().mockResolvedValueOnce(undefined),
        queueWeightPull: jest.fn().mockRejectedValueOnce(
          new Error('Queue is not ready')
        ),
      }));

      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'test',
          modelHash: 'hash',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/v1/weights/stats', () => {
    it('should return stats with 200 status', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/stats'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalled();
    });

    it('should return proper response structure for stats', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/stats'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse).toHaveProperty('totalWeights');
      expect(sentResponse).toHaveProperty('totalSizeGB');
      expect(sentResponse).toHaveProperty('cacheHitRate');
      expect(sentResponse).toHaveProperty('timing');

      expect(typeof sentResponse.totalWeights).toBe('number');
      expect(typeof sentResponse.totalSizeGB).toBe('number');
      expect(typeof sentResponse.cacheHitRate).toBe('number');
      expect(typeof sentResponse.timing).toBe('string');
    });

    it('should return correct stats values', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/stats'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.totalWeights).toBe(3);
      expect(sentResponse.totalSizeGB).toBe(45.5);
      expect(sentResponse.cacheHitRate).toBe(0.87);
    });

    it('should include timing in response', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/stats'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.timing).toMatch(/^\d+ms$/);
    });

    it('should handle empty stats', async () => {
      const { RedisWeightRegistry } = require('../../../services/swr/redisClient');
      RedisWeightRegistry.mockImplementationOnce(() => ({
        stats: jest.fn().mockResolvedValueOnce({
          totalWeights: 0,
          totalSizeGB: 0,
          cacheHitRate: 0,
        }),
      }));

      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/stats'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(200);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.totalWeights).toBe(0);
      expect(sentResponse.totalSizeGB).toBe(0);
    });

    it('should handle stats errors', async () => {
      const { RedisWeightRegistry } = require('../../../services/swr/redisClient');
      RedisWeightRegistry.mockImplementationOnce(() => ({
        stats: jest.fn().mockRejectedValueOnce(new Error('Stats computation failed')),
      }));

      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/stats'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await handler({} as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.success).toBe(false);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup services without errors', async () => {
      await registerSWRRoutes(mockFastify);
      await cleanupSWRServices();
    });

    it('should handle cleanup when queue is not initialized', async () => {
      await cleanupSWRServices();
    });
  });

  describe('Error Handling - General', () => {
    it('should have proper error structure in responses', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: '' },
      };

      await handler(request as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse).toHaveProperty('error');
      expect(sentResponse).toHaveProperty('success', false);
    });

    it('should include timing in all error responses', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.get.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/:hash'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        params: { hash: '' },
      };

      await handler(request as any, mockReply);

      const sentResponse = mockReply.send.mock.calls[0][0];
      expect(sentResponse.details).toHaveProperty('timing');
    });
  });

  describe('Performance and Timing', () => {
    it('should measure timing for all endpoints', async () => {
      await registerSWRRoutes(mockFastify);

      const listHandler = mockFastify.get.mock.calls[0][1];
      const getHandler = mockFastify.get.mock.calls[1][1];
      const statsHandler = mockFastify.get.mock.calls[2][1];
      const pullHandler = mockFastify.post.mock.calls[0][1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await listHandler({} as any, mockReply);
      let response = mockReply.send.mock.calls[0][0];
      expect(response.timing).toMatch(/^\d+ms$/);

      mockReply.send.mockClear();
      mockReply.code.mockClear();

      await getHandler({ params: { hash: 'test' } } as any, mockReply);
      response = mockReply.send.mock.calls[0][0];
      expect(response.timing).toMatch(/^\d+ms$/);

      mockReply.send.mockClear();
      mockReply.code.mockClear();

      await statsHandler({} as any, mockReply);
      response = mockReply.send.mock.calls[0][0];
      expect(response.timing).toMatch(/^\d+ms$/);

      mockReply.send.mockClear();
      mockReply.code.mockClear();

      await pullHandler(
        {
          body: {
            modelName: 'test',
            modelHash: 'hash',
            source: 'huggingface',
          },
        } as any,
        mockReply
      );
      response = mockReply.send.mock.calls[0][0];
      expect(response.timing).toMatch(/^\d+ms$/);
    });
  });

  describe('Integration - All Endpoints', () => {
    it('should have all endpoints callable', async () => {
      await registerSWRRoutes(mockFastify);

      expect(mockFastify.get).toHaveBeenCalledTimes(3);
      expect(mockFastify.post).toHaveBeenCalledTimes(1);

      const getHandlers = mockFastify.get.mock.calls.map((call: any[]) => call[1]);
      const postHandlers = mockFastify.post.mock.calls.map((call: any[]) => call[1]);

      expect(getHandlers.length).toBe(3);
      expect(postHandlers.length).toBe(1);

      getHandlers.forEach((handler: any) => {
        expect(typeof handler).toBe('function');
      });

      postHandlers.forEach((handler: any) => {
        expect(typeof handler).toBe('function');
      });
    });

    it('all endpoints should have successful requests', async () => {
      await registerSWRRoutes(mockFastify);

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      // Test list endpoint
      const listHandler = mockFastify.get.mock.calls[0][1];
      await listHandler({} as any, mockReply);
      expect(mockReply.code).toHaveBeenCalledWith(200);

      // Test get endpoint
      mockReply.send.mockClear();
      mockReply.code.mockClear();
      const getHandler = mockFastify.get.mock.calls[1][1];
      await getHandler({ params: { hash: 'test' } } as any, mockReply);
      expect(mockReply.code).toHaveBeenCalledWith(200);

      // Test stats endpoint
      mockReply.send.mockClear();
      mockReply.code.mockClear();
      const statsHandler = mockFastify.get.mock.calls[2][1];
      await statsHandler({} as any, mockReply);
      expect(mockReply.code).toHaveBeenCalledWith(200);

      // Test pull endpoint
      mockReply.send.mockClear();
      mockReply.code.mockClear();
      const pullHandler = mockFastify.post.mock.calls[0][1];
      await pullHandler(
        {
          body: {
            modelName: 'test',
            modelHash: 'hash',
            source: 'huggingface',
          },
        } as any,
        mockReply
      );
      expect(mockReply.code).toHaveBeenCalledWith(202);
    });
  });

  describe('Validation Edge Cases', () => {
    it('should handle special characters in modelName', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const request = {
        body: {
          modelName: 'meta-llama/Llama-2-7b-hf',
          modelHash: 'hash123',
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(202);
    });

    it('should handle long hashes', async () => {
      await registerSWRRoutes(mockFastify);

      const handler = mockFastify.post.mock.calls.find(
        (call: any[]) => call[0] === '/api/v1/weights/pull'
      )[1];

      const mockReply = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      const longHash = 'a'.repeat(256);
      const request = {
        body: {
          modelName: 'test',
          modelHash: longHash,
          source: 'huggingface',
        },
      };

      await handler(request as any, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(202);
    });
  });
});
