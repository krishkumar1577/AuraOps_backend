import { execSync } from 'child_process';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { blueprintRoutes } from './api/routes/blueprint.routes';
import deploymentRoutes from './api/routes/deployment.routes';
import { registerSWRRoutes } from './api/routes/swr.routes';
import { authRoutes } from './api/routes/auth.routes';
import { createDefaultOrchestrator } from './services/orchestration/defaultOrchestrator';
import authPlugin from './plugins/auth';
import { logger } from './utils/logger';
import config from './utils/config';

function logModalCliAvailability(): void {
  const paths = [
    'modal',
    '/usr/local/bin/modal',
    `${process.env.HOME}/.local/bin/modal`,
    '/root/.local/bin/modal',
  ];

  for (const p of paths) {
    try {
      const version = execSync(`${p} --version`, { timeout: 3000, encoding: 'utf-8' }).trim();
      process.env.MODAL_CLI_PATH = p;
      logger.info(`Modal CLI found at: ${p}`);
      logger.info(`Modal CLI available: ${version || 'unknown'}`);
      break;
    } catch {
      continue;
    }
  }
}

export async function createApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: true,
    bodyLimit: config.max_request_body_bytes,
    trustProxy: true,
  });

  await fastify.register(helmet, { global: true });
  await fastify.register(cors, {
    origin: config.isProd
      ? (config.cors_origin || 'https://auraops.dev')
      : true,
    credentials: true,
  });
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await fastify.register(authPlugin);

  fastify.addHook('onRequest', async (request) => {
    const isPublicRoute =
      request.url === '/' ||
      request.url === '/health' ||
      request.url.startsWith('/api/v1/auth/');
    if (isPublicRoute) {
      return;
    }

    if (request.url.startsWith('/api/v1')) {
      await request.jwtVerify();
    }
  });

  fastify.register(authRoutes);
  fastify.register(blueprintRoutes);
  fastify.register(registerSWRRoutes);
  const orchestrator = createDefaultOrchestrator(config.redis_url);
  fastify.register(async (instance) => {
    await deploymentRoutes(instance, orchestrator);
  });

  fastify.get('/health', async () => {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  });

  fastify.get('/', async () => {
    return {
      name: 'AuraOps Backend',
      version: '1.0.0-alpha',
      status: 'running',
      endpoints: {
        health: '/health',
        register: 'POST /api/v1/auth/register',
        login: 'POST /api/v1/auth/login',
        blueprintGenerate: 'POST /api/v1/blueprint/generate',
        blueprintGet: 'GET /api/v1/blueprint/:blueprintId',
        weightsListAll: 'GET /api/v1/weights',
        weightsGet: 'GET /api/v1/weights/:hash',
        weightsPull: 'POST /api/v1/weights/pull',
        weightsStats: 'GET /api/v1/weights/stats',
      },
    };
  });

  fastify.setErrorHandler((error, request, reply) => {
    logger.error({
      err: error,
      url: request.url,
      method: request.method,
    });

    reply.code(error.statusCode ?? 500).send({
      success: false,
      error: error.message || 'Internal server error',
    });
  });

  return fastify;
}

export async function startServer() {
  const fastify = await createApp();

  try {
    logModalCliAvailability();
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(`✓ Server running on http://0.0.0.0:${config.port}`);
  } catch (err) {
    logger.error(`Server startup error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
