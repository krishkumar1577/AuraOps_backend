import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RedisWeightRegistry } from '../../services/swr/redisClient';
import { BackgroundJobQueue } from '../../services/queue/backgroundJobs';
import { logger } from '../../utils/logger';
import { DeploymentError } from '../../utils/errors';

// Initialize services
let redisRegistry: RedisWeightRegistry;
let jobQueue: BackgroundJobQueue;

// Zod schemas for validation
const PullWeightSchema = z.object({
  modelName: z.string().min(1, 'Model name is required'),
  hash: z.string().min(1, 'Hash is required'),
  source: z.string().min(1, 'Source is required').refine(
    (source) =>
      source === 'huggingface' ||
      source.startsWith('http://') ||
      source.startsWith('https://'),
    'Source must be "huggingface" or a valid URL'
  ),
});

interface PullWeightRequest {
  modelName: string;
  hash: string;
  source: string;
}

interface WeightInfo {
  hash: string;
  modelName?: string;
  sizeGB: number;
  storagePath: string;
  registeredAt: string;
  ttlDays: number;
}

interface WeightStats {
  totalWeights: number;
  totalSizeGB: number;
  cacheHitRate: number;
  averageAgeDays: number;
}

export async function registerSWRRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // Initialize services
  try {
    redisRegistry = new RedisWeightRegistry();
    jobQueue = new BackgroundJobQueue();
    await jobQueue.initialize();

    logger.info('✓ SWR routes initialized');
  } catch (error) {
    throw new DeploymentError('Failed to initialize SWR routes', { cause: error });
  }

  /**
   * GET /api/v1/weights
   * List all cached weights
   */
  fastify.get<{ Reply: WeightInfo[] }>(
    '/api/v1/weights',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const start = Date.now();

        // For now, return empty array (real implementation would query cache)
        const weights: WeightInfo[] = [];

        logger.info(
          `✓ List weights complete: ${weights.length} weights (${Date.now() - start}ms)`
        );

        return reply.code(200).send(weights);
      } catch (error) {
        logger.error(`Failed to list weights: ${error}`);
        throw new DeploymentError('Failed to list weights', { cause: error });
      }
    }
  );

  /**
   * GET /api/v1/weights/:hash
   * Get weight details by hash
   */
  fastify.get<{ Params: { hash: string }; Reply: WeightInfo | null }>(
    '/api/v1/weights/:hash',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { hash } = request.params as { hash: string };
        const start = Date.now();

        if (!hash || hash.trim().length === 0) {
          return reply.code(400).send({
            error: 'Hash parameter is required',
          });
        }

        const weight = await redisRegistry.lookup(hash);

        if (!weight) {
          logger.info(`Weight not found: ${hash}`);
          return reply.code(404).send({
            error: `Weight not found: ${hash}`,
          });
        }

        logger.info(
          `✓ Get weight complete: ${hash} (${Date.now() - start}ms)`
        );

        return reply.code(200).send(weight);
      } catch (error) {
        logger.error(`Failed to get weight: ${error}`);
        throw new DeploymentError('Failed to get weight', { cause: error });
      }
    }
  );

  /**
   * POST /api/v1/weights/pull
   * Queue background weight pull
   */
  fastify.post<{ Body: PullWeightRequest; Reply: { jobId: string } }>(
    '/api/v1/weights/pull',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const start = Date.now();

        // Validate request body
        const validated = PullWeightSchema.parse(request.body);

        const jobId = await jobQueue.queueWeightPull(
          validated.modelName,
          validated.hash,
          validated.source
        );

        logger.info(
          `✓ Pull weight queued: ${validated.modelName} (job: ${jobId}, ${Date.now() - start}ms)`
        );

        return reply.code(202).send({
          jobId,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          logger.warn(`Validation error: ${error.message}`);
          return reply.code(400).send({
            error: 'Validation failed',
            details: error.errors,
          });
        }

        logger.error(`Failed to queue pull: ${error}`);
        throw new DeploymentError('Failed to queue weight pull', { cause: error });
      }
    }
  );

  /**
   * GET /api/v1/weights/stats
   * Get weight cache statistics
   */
  fastify.get<{ Reply: WeightStats }>(
    '/api/v1/weights/stats',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const start = Date.now();

        const stats = await redisRegistry.stats();

        const response: WeightStats = {
          totalWeights: stats.totalWeights || 0,
          totalSizeGB: stats.totalSizeGB || 0,
          cacheHitRate: stats.cacheHitRate || 0,
          averageAgeDays: 0,
        };

        logger.info(
          `✓ Stats complete: ${response.totalWeights} weights, ${response.totalSizeGB}GB (${Date.now() - start}ms)`
        );

        return reply.code(200).send(response);
      } catch (error) {
        logger.error(`Failed to get stats: ${error}`);
        throw new DeploymentError('Failed to get weight stats', { cause: error });
      }
    }
  );

  logger.info('✓ SWR routes registered');
}

export async function cleanupSWRServices(): Promise<void> {
  try {
    if (jobQueue) {
      await jobQueue.dispose();
    }

    logger.info('✓ SWR services cleaned up');
  } catch (error) {
    logger.error(`Failed to cleanup SWR services: ${error}`);
  }
}
