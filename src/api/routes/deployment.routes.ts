import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { Orchestrator, WorkerRequirements, DeploymentStatus } from '../../services/orchestration';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { BlueprintJSON } from '../../types/blueprint.types';

// Zod schemas for request validation
const GPURequirementsSchema = z.object({
  minMemory: z.number().positive('GPU memory must be positive'),
  framework: z.string().min(1, 'Framework name required'),
  pythonVersion: z.string().regex(/^\d+\.\d+/, 'Invalid Python version format'),
});

const DeployRequestSchema = z.object({
  blueprintId: z.string().uuid('Invalid blueprint ID format'),
  blueprintJson: z.object({
    id: z.string(),
    timestamp: z.string(),
    framework: z.object({
      framework: z.string(),
      version: z.string(),
      cudaVersion: z.string(),
      pythonVersion: z.string(),
      primaryUse: z.string(),
    }),
    systemRequirements: z.object({
      baseImageId: z.string(),
      baseImageTag: z.string(),
    }),
  }),
  lockfilePath: z.string().min(1, 'Lockfile path required'),
  environmentHash: z.string().min(1, 'Environment hash required'),
  gpuRequirements: GPURequirementsSchema,
});

const DeploymentIdParamSchema = z.object({
  deploymentId: z.string().uuid('Invalid deployment ID format'),
});

type DeployRequest = z.infer<typeof DeployRequestSchema>;

interface DeploymentRecord {
  deploymentId: string;
  agentId: string;
  workerId: string;
  status: 'pending' | 'deploying' | 'running' | 'failed';
  startTime: number;
  estimatedTime: number;
  blueprintId: string;
  lockfilePath: string;
  environmentHash: string;
  error?: string;
}

export async function deploymentRoutes(
  fastify: FastifyInstance,
  orchestrator: Orchestrator,
): Promise<void> {
  // In-memory storage for deployment records (in production, use Redis)
  const deployments = new Map<string, DeploymentRecord>();

  /**
   * POST /api/v1/deploy
   * Deploy AI agent to GPU
   */
  fastify.post<{ Body: unknown }>(
    '/api/v1/deploy',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const startTime = Date.now();

      try {
        // Validate request body
        let validatedData: DeployRequest;
        try {
          validatedData = DeployRequestSchema.parse(request.body);
        } catch (error) {
          if (error instanceof z.ZodError) {
            logger.warn(`Deploy validation error: ${error.message}`);
            const statusCode = 400;
            return reply.code(statusCode).send({
              success: false,
              error: 'Invalid request',
              details: error.errors.map(e => ({
                field: e.path.join('.'),
                message: e.message,
              })),
            });
          }
          throw error;
        }

        const {
          blueprintId,
          blueprintJson,
          lockfilePath,
          environmentHash,
          gpuRequirements,
        } = validatedData;

        logger.info(
          `Starting deployment: blueprintId=${blueprintId}, framework=${gpuRequirements.framework}`,
        );

        // Acquire worker
        const workerRequirements: WorkerRequirements = {
          minGPUMemory: gpuRequirements.minMemory,
          framework: gpuRequirements.framework,
          pythonVersion: gpuRequirements.pythonVersion,
        };

        let workerId: string;
        let workerStartTime = Date.now();
        try {
          const worker = await orchestrator.acquireWorker(workerRequirements);
          workerId = worker.workerId;
          const workerTime = Date.now() - workerStartTime;
          logger.info(`✓ Worker acquired in ${workerTime}ms: ${workerId}`);
        } catch (error) {
          const err = error instanceof DeploymentError ? error : new DeploymentError(
            error instanceof Error ? error.message : 'Worker acquisition failed',
            { blueprintId },
          );

          if (err.statusCode === 409 || err.message.includes('No available workers')) {
            logger.warn(`No available workers for deployment: ${blueprintId}`);
            return reply.code(409).send({
              success: false,
              error: 'No available workers matching requirements',
              details: { requirements: workerRequirements },
            });
          }

          if (err.message.includes('timeout')) {
            logger.warn(`Worker acquisition timeout for deployment: ${blueprintId}`);
            return reply.code(504).send({
              success: false,
              error: 'Worker acquisition timeout',
            });
          }

          throw err;
        }

        // Deploy agent to worker
        const deploymentId = uuidv4();
        const agentIdRef = { value: '' };

        let agentStartTime = Date.now();
        try {
          const result = await orchestrator.deployAgent(
            workerId,
            blueprintJson as BlueprintJSON,
            lockfilePath,
            environmentHash,
          );

          agentIdRef.value = result.agentId;
          const agentTime = Date.now() - agentStartTime;
          logger.info(`✓ Agent deployed in ${agentTime}ms: agentId=${result.agentId}`);
        } catch (error) {
          const err = error instanceof DeploymentError ? error : new DeploymentError(
            error instanceof Error ? error.message : 'Agent deployment failed',
            { blueprintId, workerId },
          );

          // Release worker on failure
          try {
            await orchestrator.releaseWorker(workerId);
            logger.info(`Worker released after deployment failure: ${workerId}`);
          } catch (releaseError) {
            logger.warn(
              `Failed to release worker: ${releaseError instanceof Error ? releaseError.message : 'unknown error'}`,
            );
          }

          if (err.message.includes('timeout')) {
            logger.warn(`Agent deployment timeout: blueprintId=${blueprintId}`);
            return reply.code(504).send({
              success: false,
              error: 'Deployment timeout',
              details: { blueprintId },
            });
          }

          throw err;
        }

        // Store deployment record
        const totalTime = Date.now() - startTime;
        const deployment: DeploymentRecord = {
          deploymentId,
          agentId: agentIdRef.value,
          workerId,
          status: 'running',
          startTime: Date.now(),
          estimatedTime: totalTime,
          blueprintId,
          lockfilePath,
          environmentHash,
        };

        deployments.set(deploymentId, deployment);
        logger.info(
          `✓ Deployment recorded in ${Date.now() - startTime}ms: deploymentId=${deploymentId}`,
        );

        return reply.code(201).send({
          success: true,
          deploymentId,
          agentId: agentIdRef.value,
          workerId,
          status: 'running',
          createdAt: Date.now(),
          estimatedTime: totalTime,
        });
      } catch (error) {
        const err = error instanceof DeploymentError ? error : new DeploymentError(
          error instanceof Error ? error.message : 'Internal server error',
        );

        logger.error(
          `Deployment error: ${err.message}, details: ${JSON.stringify(err.details)}`,
        );

        return reply.code(err.statusCode || 500).send({
          success: false,
          error: err.message,
          details: err.details,
        });
      }
    },
  );

  /**
   * GET /api/v1/deployment/:deploymentId
   * Get deployment status
   */
  fastify.get<{ Params: unknown }>(
    '/api/v1/deployment/:deploymentId',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const params = request.params as Record<string, string>;
        const { deploymentId } = DeploymentIdParamSchema.parse(params);

        const deployment = deployments.get(deploymentId);
        if (!deployment) {
          logger.warn(`Deployment not found: ${deploymentId}`);
          return reply.code(404).send({
            success: false,
            error: 'Deployment not found',
            deploymentId,
          });
        }

        // Get detailed status from orchestrator
        const startTime = Date.now();
        let agentStatus;
        try {
          agentStatus = await orchestrator.getDeploymentStatus(deployment.agentId);
        } catch (error) {
          logger.warn(`Failed to get agent status: ${deploymentId}`);
          // Return cached deployment info if orchestrator lookup fails
          return reply.code(200).send({
            success: true,
            deploymentId,
            agentId: deployment.agentId,
            workerId: deployment.workerId,
            status: deployment.status,
            startTime: deployment.startTime,
            latency: Date.now() - startTime,
          });
        }

        const responseTime = Date.now() - startTime;
        logger.info(`✓ Status retrieved in ${responseTime}ms: deploymentId=${deploymentId}`);

        return reply.code(200).send({
          success: true,
          deploymentId,
          agentId: agentStatus.agentId,
          workerId: agentStatus.workerId,
          status: agentStatus.status,
          startTime: agentStatus.startTime,
          latency: responseTime,
          gpuUtilization: agentStatus.gpuUtilization,
          error: agentStatus.error,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          logger.warn(`Status parameter validation error: ${error.message}`);
          return reply.code(400).send({
            success: false,
            error: 'Invalid deployment ID format',
          });
        }

        const err = error instanceof DeploymentError ? error : new DeploymentError(
          error instanceof Error ? error.message : 'Failed to get deployment status',
        );

        logger.error(`Status lookup error: ${err.message}`);
        return reply.code(err.statusCode || 500).send({
          success: false,
          error: err.message,
        });
      }
    },
  );

  /**
   * DELETE /api/v1/deployment/:deploymentId
   * Cleanup and release GPU
   */
  fastify.delete<{ Params: unknown }>(
    '/api/v1/deployment/:deploymentId',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const params = request.params as Record<string, string>;
        const { deploymentId } = DeploymentIdParamSchema.parse(params);

        const deployment = deployments.get(deploymentId);
        if (!deployment) {
          logger.warn(`Deployment not found for cleanup: ${deploymentId}`);
          return reply.code(404).send({
            success: false,
            error: 'Deployment not found',
            deploymentId,
          });
        }

        logger.info(
          `Releasing deployment: deploymentId=${deploymentId}, workerId=${deployment.workerId}`,
        );

        // Release worker
        const startTime = Date.now();
        try {
          await orchestrator.releaseWorker(deployment.workerId);
          const releaseTime = Date.now() - startTime;
          logger.info(`✓ Worker released in ${releaseTime}ms: ${deployment.workerId}`);
        } catch (error) {
          const err = error instanceof DeploymentError ? error : new DeploymentError(
            error instanceof Error ? error.message : 'Failed to release worker',
            { deploymentId, workerId: deployment.workerId },
          );

          logger.error(`Worker release error: ${err.message}`);
          // Don't fail the request, just log the error
        }

        // Remove deployment record
        deployments.delete(deploymentId);

        const totalTime = Date.now() - startTime;
        logger.info(`✓ Deployment cleanup complete in ${totalTime}ms: deploymentId=${deploymentId}`);

        return reply.code(200).send({
          success: true,
          deploymentId,
          status: 'released',
          releasedAt: Date.now(),
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          logger.warn(`Release parameter validation error: ${error.message}`);
          return reply.code(400).send({
            success: false,
            error: 'Invalid deployment ID format',
          });
        }

        const err = error instanceof DeploymentError ? error : new DeploymentError(
          error instanceof Error ? error.message : 'Failed to release deployment',
        );

        logger.error(`Release error: ${err.message}`);
        return reply.code(err.statusCode || 500).send({
          success: false,
          error: err.message,
        });
      }
    },
  );

  /**
   * GET /api/v1/agents
   * List all deployed agents
   */
  fastify.get<{ Querystring: unknown }>(
    '/api/v1/agents',
    async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const startTime = Date.now();
        logger.info('Listing all deployed agents');

        // Get all deployment statuses from orchestrator
        let orchestratorDeployments: DeploymentStatus[] = [];
        try {
          orchestratorDeployments = await orchestrator.listDeployments();
        } catch (error) {
          logger.warn(
            `Failed to list deployments from orchestrator: ${error instanceof Error ? error.message : 'unknown'}`,
          );
          orchestratorDeployments = [];
        }

        // Map to agent list format
        const agents = orchestratorDeployments.map(dep => {
          const deployment = deployments.get(
            Array.from(deployments.entries()).find(
              ([, d]) => d.agentId === dep.agentId,
            )?.[0] || '',
          );

          return {
            deploymentId: deployment?.deploymentId || 'unknown',
            agentId: dep.agentId,
            status: dep.status,
            gpuType: 'gpu', // Would come from worker info in production
            uptime: dep.startTime ? Date.now() - dep.startTime : 0,
            gpuUtilization: dep.gpuUtilization,
            workerId: dep.workerId,
          };
        });

        const responseTime = Date.now() - startTime;
        logger.info(`✓ Listed ${agents.length} agents in ${responseTime}ms`);

        return reply.code(200).send({
          success: true,
          agents,
          total: agents.length,
          timestamp: Date.now(),
        });
      } catch (error) {
        const err = error instanceof DeploymentError ? error : new DeploymentError(
          error instanceof Error ? error.message : 'Failed to list agents',
        );

        logger.error(`List agents error: ${err.message}`);
        return reply.code(err.statusCode || 500).send({
          success: false,
          error: err.message,
        });
      }
    },
  );
}

export default deploymentRoutes;
