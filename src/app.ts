import Fastify, { FastifyInstance } from 'fastify';
import { blueprintRoutes } from './api/routes/blueprint.routes';
import { logger } from './utils/logger';
import config from './utils/config';

export async function createApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: logger,
  });

  fastify.register(blueprintRoutes);

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
        blueprintGenerate: 'POST /api/v1/blueprint/generate',
        blueprintGet: 'GET /api/v1/blueprint/:blueprintId',
      },
    };
  });

  fastify.setErrorHandler((error, request, reply) => {
    const err = error as any;
    logger.error({
      err,
      url: request.url,
      method: request.method,
    });

    reply.code(err?.statusCode || 500).send({
      success: false,
      error: err?.message || 'Internal server error',
    });
  });

  return fastify;
}

export async function startServer() {
  const fastify = await createApp();

  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(`✓ Server running on http://0.0.0.0:${config.port}`);
  } catch (err) {
    const error = err as any;
    logger.error('Server startup error:', error);
    process.exit(1);
  }
}
