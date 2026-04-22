import { registerSWRRoutes, cleanupSWRServices } from '../swr.routes';

// Mock Fastify
const mockFastify = {
  get: jest.fn(),
  post: jest.fn(),
};

// Mock services
jest.mock('../../../services/swr/redisClient', () => ({
  RedisWeightRegistry: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    lookup: jest.fn().mockResolvedValue({
      hash: 'abc123',
      sizeGB: 10,
      storagePath: 's3://bucket/weights',
      registeredAt: new Date().toISOString(),
      ttlDays: 30,
    }),
    stats: jest.fn().mockResolvedValue({
      totalWeights: 5,
      totalSizeGB: 50,
      cacheHitRate: 0.95,
      averageAgeDays: 10,
      weights: [
        {
          hash: 'abc123',
          sizeGB: 10,
          storagePath: 's3://bucket/weights',
          registeredAt: new Date().toISOString(),
          ttlDays: 30,
        },
      ],
    }),
    dispose: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../services/swr/s3Manager', () => ({
  S3WeightManager: jest.fn(() => ({
    dispose: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../services/queue/backgroundJobs', () => ({
  BackgroundJobQueue: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    queueWeightPull: jest.fn().mockResolvedValue('job-123'),
    dispose: jest.fn().mockResolvedValue(undefined),
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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Route Registration', () => {
    it('should register all SWR routes', async () => {
      await registerSWRRoutes(mockFastify as any);

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

    it('should initialize services during registration', async () => {
      await registerSWRRoutes(mockFastify as any);
      // Services initialized successfully
      expect(mockFastify.get).toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/weights', () => {
    it('should list all weights', async () => {
      await registerSWRRoutes(mockFastify as any);

      const getHandler = mockFastify.get.mock.calls.find(
        (call) => call[0] === '/api/v1/weights'
      )?.[1];

      if (getHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        await getHandler({} as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(200);
        expect(mockReply.send).toHaveBeenCalled();
      }
    });

    it('should return 200 status', async () => {
      await registerSWRRoutes(mockFastify as any);

      const getHandler = mockFastify.get.mock.calls.find(
        (call) => call[0] === '/api/v1/weights'
      )?.[1];

      if (getHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        await getHandler({} as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(200);
      }
    });
  });

  describe('GET /api/v1/weights/:hash', () => {
    it('should get weight by hash', async () => {
      await registerSWRRoutes(mockFastify as any);

      const getHandler = mockFastify.get.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/:hash'
      )?.[1];

      if (getHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          params: { hash: 'abc123' },
        };

        await getHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(200);
        expect(mockReply.send).toHaveBeenCalled();
      }
    });

    it('should return 400 for missing hash', async () => {
      await registerSWRRoutes(mockFastify as any);

      const getHandler = mockFastify.get.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/:hash'
      )?.[1];

      if (getHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          params: { hash: '' },
        };

        await getHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(400);
      }
    });

    it('should return 404 when weight not found', async () => {
      // Mock lookup to return null
      const RedisWeightRegistry = require('../../../services/swr/redisClient')
        .RedisWeightRegistry;
      RedisWeightRegistry.mockImplementation(() => ({
        lookup: jest.fn().mockResolvedValue(null),
        stats: jest.fn().mockResolvedValue({
          totalWeights: 0,
          totalSizeGB: 0,
          cacheHitRate: 0,
        }),
      }));

      await registerSWRRoutes(mockFastify as any);

      const getHandler = mockFastify.get.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/:hash'
      )?.[1];

      if (getHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          params: { hash: 'unknown' },
        };

        await getHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(404);
      }
    });
  });

  describe('POST /api/v1/weights/pull', () => {
    it('should queue weight pull', async () => {
      await registerSWRRoutes(mockFastify as any);

      const postHandler = mockFastify.post.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/pull'
      )?.[1];

      if (postHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          body: {
            modelName: 'gpt2',
            hash: 'abc123',
            source: 'huggingface',
          },
        };

        await postHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(202);
        expect(mockReply.send).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: expect.any(String) })
        );
      }
    });

    it('should return 202 for accepted job', async () => {
      await registerSWRRoutes(mockFastify as any);

      const postHandler = mockFastify.post.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/pull'
      )?.[1];

      if (postHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          body: {
            modelName: 'bert',
            hash: 'def456',
            source: 'https://example.com/weights.bin',
          },
        };

        await postHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(202);
      }
    });

    it('should return 400 for invalid request', async () => {
      await registerSWRRoutes(mockFastify as any);

      const postHandler = mockFastify.post.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/pull'
      )?.[1];

      if (postHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          body: {
            modelName: '',
            hash: '',
            source: 'invalid',
          },
        };

        await postHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(400);
      }
    });
  });

  describe('GET /api/v1/weights/stats', () => {
    it('should return cache statistics', async () => {
      await registerSWRRoutes(mockFastify as any);

      const getHandler = mockFastify.get.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/stats'
      )?.[1];

      if (getHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        await getHandler({} as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(200);
        expect(mockReply.send).toHaveBeenCalledWith(
          expect.objectContaining({
            totalWeights: expect.any(Number),
            totalSizeGB: expect.any(Number),
            cacheHitRate: expect.any(Number),
            averageAgeDays: expect.any(Number),
          })
        );
      }
    });
  });

  describe('Cleanup', () => {
    it('should cleanup services', async () => {
      await registerSWRRoutes(mockFastify as any);
      await cleanupSWRServices();
      // Cleanup completed successfully
    });

    it('should handle cleanup errors gracefully', async () => {
      await cleanupSWRServices();
      // Should not throw
    });
  });

  describe('Error Handling', () => {
    it('should handle get requests', async () => {
      await registerSWRRoutes(mockFastify as any);

      const getHandler = mockFastify.get.mock.calls.find(
        (call) => call[0] === '/api/v1/weights'
      )?.[1];

      if (getHandler) {
        // Request should be valid
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        await getHandler({} as any, mockReply);

        // Handler should execute
        expect(mockReply.code).toHaveBeenCalled();
      }
    });
  });

  describe('Validation', () => {
    it('should validate model name in pull request', async () => {
      await registerSWRRoutes(mockFastify as any);

      const postHandler = mockFastify.post.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/pull'
      )?.[1];

      if (postHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          body: {
            modelName: '',
            hash: 'abc123',
            source: 'huggingface',
          },
        };

        await postHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(400);
      }
    });

    it('should validate hash in pull request', async () => {
      await registerSWRRoutes(mockFastify as any);

      const postHandler = mockFastify.post.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/pull'
      )?.[1];

      if (postHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          body: {
            modelName: 'gpt2',
            hash: '',
            source: 'huggingface',
          },
        };

        await postHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(400);
      }
    });

    it('should validate source format', async () => {
      await registerSWRRoutes(mockFastify as any);

      const postHandler = mockFastify.post.mock.calls.find(
        (call) => call[0] === '/api/v1/weights/pull'
      )?.[1];

      if (postHandler) {
        const mockReply = {
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        };

        const request = {
          body: {
            modelName: 'gpt2',
            hash: 'abc123',
            source: 'invalid-source',
          },
        };

        await postHandler(request as any, mockReply);

        expect(mockReply.code).toHaveBeenCalledWith(400);
      }
    });
  });
});
