import { FastifyPluginAsync } from 'fastify';

jest.mock('../../../services/auth/userRepository', () => {
  const users = new Map<string, { _id: { toHexString: () => string }, email: string, passwordHash: string, createdAt: Date }>();

  return {
    createUser: jest.fn(async (email: string, passwordHash: string) => {
      if (users.has(email.toLowerCase())) {
        const err = new Error(`Email already registered: ${email}`) as Error & { statusCode: number };
        err.statusCode = 409;
        throw err;
      }
      const id = `user-${Date.now()}`;
      const user = {
        _id: { toHexString: () => id },
        email: email.toLowerCase(),
        passwordHash,
        createdAt: new Date(),
      };
      users.set(email.toLowerCase(), user);
      return { id, email: email.toLowerCase(), createdAt: user.createdAt };
    }),
    findByEmail: jest.fn(async (email: string) => {
      return users.get(email.toLowerCase()) || null;
    }),
    findById: jest.fn(async () => null),
    closeConnection: jest.fn(),
    __resetUsers: () => users.clear(),
  };
});

jest.mock('../../../api/routes/blueprint.routes', () => ({
  blueprintRoutes: (async () => {}) as FastifyPluginAsync,
}));

jest.mock('../../../api/routes/swr.routes', () => ({
  registerSWRRoutes: (async () => {}) as FastifyPluginAsync,
}));

jest.mock('../../../api/routes/deployment.routes', () => ({
  __esModule: true,
  default: async () => {},
}));

jest.mock('../../../services/orchestration/defaultOrchestrator', () => ({
  createDefaultOrchestrator: jest.fn(() => ({})),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __resetUsers } = require('../../../services/auth/userRepository');

describe('Auth routes', () => {
  let app: Awaited<ReturnType<typeof import('../../../app').createApp>>;

  beforeAll(async () => {
    const { createApp } = await import('../../../app');
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    __resetUsers();
  });

  describe('POST /api/v1/auth/register', () => {
    it('should register a new user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'test@example.com', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.token).toBeDefined();
      expect(body.user.email).toBe('test@example.com');
    });

    it('should reject duplicate email', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'dupe@example.com', password: 'securepass123' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'dupe@example.com', password: 'anotherpass123' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().success).toBe(false);
    });

    it('should reject short password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'test@example.com', password: 'short' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Validation failed');
    });

    it('should reject invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'not-an-email', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should login with correct credentials', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'login@example.com', password: 'securepass123' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'login@example.com', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.token).toBeDefined();
    });

    it('should reject wrong password', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'wrong@example.com', password: 'securepass123' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'wrong@example.com', password: 'badpassword1' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().success).toBe(false);
    });

    it('should reject non-existent user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ghost@example.com', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return token that works on protected routes', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'tokentest@example.com', password: 'securepass123' },
      });

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'tokentest@example.com', password: 'securepass123' },
      });

      const { token } = loginRes.json();

      const protectedRes = await app.inject({
        method: 'GET',
        url: '/api/v1/agents',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(protectedRes.statusCode).not.toBe(401);
    });
  });

  describe('Auth route is public', () => {
    it('should not require JWT for register', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'public@example.com', password: 'securepass123' },
      });

      expect(response.statusCode).not.toBe(401);
    });

    it('should not require JWT for login', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'loginpublic@example.com', password: 'securepass123' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'loginpublic@example.com', password: 'securepass123' },
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
