import { FastifyPluginAsync } from 'fastify';

// Mock Fastify plugins as proper plugins
const mockPlugin: FastifyPluginAsync = async (_fastify) => {
  // No-op plugin
};

jest.mock('@fastify/cors', () => ({
  __esModule: true,
  default: mockPlugin,
}));

jest.mock('@fastify/helmet', () => ({
  __esModule: true,
  default: mockPlugin,
}));

jest.mock('@fastify/rate-limit', () => ({
  __esModule: true,
  default: mockPlugin,
}));

// Mock Redis client to prevent connection attempts
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    isOpen: true,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(0),
  })),
}));

jest.mock('../utils/config', () => ({
  __esModule: true,
  default: {
    modal_token_id: '',
    modal_token_secret: '',
    redis_url: 'redis://localhost:6379',
    jwt_secret: 'test-secret-key-for-testing',
  },
  config: {
    modal_token_id: '',
    modal_token_secret: '',
    redis_url: 'redis://localhost:6379',
    jwt_secret: 'test-secret-key-for-testing',
  },
}));

jest.mock('../services/orchestration/providers/modalProvider', () => ({
  ModalProvider: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    acquireGPU: jest.fn(),
    releaseGPU: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../api/routes/blueprint.routes', () => ({
  blueprintRoutes: (async (fastify) => {
    fastify.get('/api/v1/blueprint/test', async () => ({ ok: true }));
  }) as FastifyPluginAsync,
}));

jest.mock('../api/routes/swr.routes', () => ({
  registerSWRRoutes: (async (fastify) => {
    fastify.get('/api/v1/weights', async () => ({ ok: true }));
  }) as FastifyPluginAsync,
}));

jest.mock('../api/routes/deployment.routes', () => ({
  __esModule: true,
  default: async (fastify: any) => {
    fastify.post('/api/v1/deploy', async () => ({ ok: true }));
  },
}));

jest.mock('../services/orchestration/defaultOrchestrator', () => ({
  createDefaultOrchestrator: jest.fn(() => ({})),
}));

describe('App auth integration', () => {
  it('allows public health endpoint', async () => {
    const { createApp } = await import('../app');
    const app = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  }, 15000);

  it('blocks private API endpoint without token', async () => {
    const { createApp } = await import('../app');
    const app = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/weights',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
    await app.close();
  }, 15000);

  it('accepts private API endpoint with valid token', async () => {
    const { createApp } = await import('../app');
    const app = await createApp();
    const token = app.jwt.sign({ sub: 'test-user' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/weights',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  }, 15000);
});
