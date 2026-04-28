import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RedisWeightRegistry, CachedWeight } from '../../services/swr/redisClient';
import { BackgroundJobQueue } from '../../services/queue/backgroundJobs';
import { logger } from '../../utils/logger';
import { DeploymentError } from '../../utils/errors';

// Initialize services
let redisRegistry: RedisWeightRegistry;
let jobQueue: BackgroundJobQueue;

/**
 * Validation schemas
 */
const PullWeightSchema = z.object({
  modelName: z.string().min(1, 'Model name is required'),
  modelHash: z.string().min(1, 'Model hash is required'),
  source: z.string().min(1, 'Source is required').refine(
    (source) =>
      source === 'huggingface' ||
      source.startsWith('http://') ||
      source.startsWith('https://'),
    'Source must be "huggingface" or a valid URL'
  ),
});

/**
 * Response types
 */
interface PullWeightRequest {
  modelName: string;
  modelHash: string;
  source: 'huggingface' | 'custom-url';
  sourceUrl?: string;
}

interface PullWeightResponse {
  success: boolean;
  jobId: string;
  status: string;
  eta: string;
  timing: string;
}

interface ListWeightsResponse {
  weights: CachedWeight[];
  totalCount: number;
  timing: string;
}

interface GetWeightResponse {
  weight: CachedWeight;
  timing: string;
}

interface StatsResponse {
  totalWeights: number;
  totalSizeGB: number;
  cacheHitRate: number;
  timing: string;
}

interface ErrorResponse {
  success: boolean;
  error: string;
  details?: Record<string, any>;
}

/**
 * Register SWR routes with Fastify
 */
export async function registerSWRRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const initStart = Date.now();

  try {
    redisRegistry = new RedisWeightRegistry();
    jobQueue = new BackgroundJobQueue();
    await jobQueue.initialize();

    logger.info(`✓ SWR routes initialized (${Date.now() - initStart}ms)`);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error(`SWR routes initialization failed: ${err}`);
    throw new DeploymentError('Failed to initialize SWR routes', {
      cause: err,
    });
  }

  /**
   * GET /api/v1/weights
   * List all cached weights with metadata
   */
  fastify.get<{ Reply: ListWeightsResponse | ErrorResponse }>(
    '/api/v1/weights',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const start = Date.now();

      try {
        const stats = await redisRegistry.stats();
        const timing = Date.now() - start;

        // In a full implementation, we'd load all weight details from Redis
        // For now, return aggregated stats
        logger.info(
          `✓ List weights complete (${timing}ms)`
        );

        return reply.code(200).send({
          weights: [],
          totalCount: stats.totalWeights,
          timing: `${timing}ms`,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to list weights: ${err}`);

        return reply.code(500).send({
          success: false,
          error: 'Failed to list weights',
          details: { cause: err },
        });
      }
    }
  );

  /**
   * GET /api/v1/weights/:hash
   * Get weight details by hash
   */
  fastify.get<{ Params: { hash: string }; Reply: GetWeightResponse | ErrorResponse }>(
    '/api/v1/weights/:hash',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const start = Date.now();

      try {
        const { hash } = request.params as { hash: string };

        if (!hash || hash.trim().length === 0) {
          const timing = Date.now() - start;
          return reply.code(400).send({
            success: false,
            error: 'Hash parameter is required',
            details: { timing: `${timing}ms` },
          });
        }

        const weight = await redisRegistry.lookup(hash);

        if (!weight) {
          const timing = Date.now() - start;
          logger.info(`Weight not found: ${hash} (${timing}ms)`);
          return reply.code(404).send({
            success: false,
            error: `Weight not found: ${hash}`,
            details: { timing: `${timing}ms` },
          });
        }

        const timing = Date.now() - start;
        logger.info(`✓ Get weight complete: ${hash} (${timing}ms)`);

        return reply.code(200).send({
          weight,
          timing: `${timing}ms`,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to get weight: ${err}`);

        const timing = Date.now() - start;
        return reply.code(500).send({
          success: false,
          error: 'Failed to get weight',
          details: { cause: err, timing: `${timing}ms` },
        });
      }
    }
  );

  /**
   * POST /api/v1/weights/pull
   * Queue background weight pull from source
   */
  fastify.post<{ Body: PullWeightRequest; Reply: PullWeightResponse | ErrorResponse }>(
    '/api/v1/weights/pull',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const start = Date.now();

      try {
        // Validate request body
        const validated = PullWeightSchema.parse(request.body);

        // Map source to queue format
        let source: 'huggingface' | 'custom-url' = 'custom-url';
        let sourceUrl: string | undefined;

        if (validated.source === 'huggingface') {
          source = 'huggingface';
        } else {
          source = 'custom-url';
          sourceUrl = validated.source;
        }

        // Queue the job
        const jobId = await jobQueue.queueWeightPull(
          validated.modelName,
          validated.modelHash,
          source,
          sourceUrl
        );

        const timing = Date.now() - start;
        logger.info(
          `✓ Weight pull queued: ${validated.modelName} (job: ${jobId}, ${timing}ms)`
        );

        return reply.code(202).send({
          success: true,
          jobId,
          status: 'queued',
          eta: '15 minutes',
          timing: `${timing}ms`,
        });
      } catch (error) {
        const timing = Date.now() - start;

        if (error instanceof z.ZodError) {
          logger.warn(`Validation error: ${error.message}`);
          return reply.code(400).send({
            success: false,
            error: 'Validation failed',
            details: {
              errors: error.errors.map((e) => ({
                path: e.path.join('.'),
                message: e.message,
              })),
              timing: `${timing}ms`,
            },
          });
        }

        if (error instanceof DeploymentError) {
          logger.error(`Failed to queue pull: ${error.message}`);
          return reply.code(error.statusCode).send({
            success: false,
            error: error.message,
            details: { ...error.details, timing: `${timing}ms` },
          });
        }

        const err = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to queue pull: ${err}`);
        return reply.code(500).send({
          success: false,
          error: 'Failed to queue weight pull',
          details: { cause: err, timing: `${timing}ms` },
        });
      }
    }
  );

  /**
   * GET /api/v1/weights/stats
   * Get weight cache statistics
   */
  fastify.get<{ Reply: StatsResponse | ErrorResponse }>(
    '/api/v1/weights/stats',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const start = Date.now();

      try {
        const stats = await redisRegistry.stats();
        const timing = Date.now() - start;

        logger.info(
          `✓ Cache stats retrieved: ${stats.totalWeights} weights, ${stats.totalSizeGB}GB, ${(stats.cacheHitRate * 100).toFixed(1)}% hit rate (${timing}ms)`
        );

        return reply.code(200).send({
          totalWeights: stats.totalWeights,
          totalSizeGB: stats.totalSizeGB,
          cacheHitRate: stats.cacheHitRate,
          timing: `${timing}ms`,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to get stats: ${err}`);

        const timing = Date.now() - start;
        return reply.code(500).send({
          success: false,
          error: 'Failed to get weight stats',
          details: { cause: err, timing: `${timing}ms` },
        });
      }
    }
  );

  logger.info('✓ SWR routes registered');
}

/**
 * Cleanup SWR services
 */
export async function cleanupSWRServices(): Promise<void> {
  try {
    if (jobQueue) {
      await jobQueue.dispose();
    }

    logger.info('✓ SWR services cleaned up');
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to cleanup SWR services: ${err}`);
  }
}
