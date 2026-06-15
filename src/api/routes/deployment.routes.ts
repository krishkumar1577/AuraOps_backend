import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  Orchestrator,
  DeploymentRecord,
  DeploymentLogEntry,
} from '../../services/orchestration';
import { RedisWeightRegistry } from '../../services/swr/redisClient';
import { ImageLayerCache } from '../../services/swr/imageLayerCache';
import { ModalAppDeployer } from '../../services/orchestration/modalAppDeployer';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';
import type { BlueprintJSON } from '../../types/blueprint.types';
import { deployTelemetry } from '../../services/telemetry/deployTelemetry';
import {
  generateMcpServerCard,
  generateClaudeDesktopConfig,
  serializeClaudeDesktopConfig,
  type ClaudeDesktopConfig,
} from '../../services/mcp/mcpCardGenerator';

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
    dependencyLock: z.record(z.string()).optional(),
    deploymentConfig: z.object({
      gpuMemoryGB: z.number().optional(),
      entrypoint: z.string().optional(),
    }).optional(),
    customModels: z.array(z.any()).optional(),
  }),
  lockfilePath: z.string(),
  environmentHash: z.string().min(1, 'Environment hash required'),
  gpuRequirements: GPURequirementsSchema,
  gpuCount: z.number().int().min(1, 'GPU count must be at least 1').max(8, 'GPU count cannot exceed 8').optional().default(1),
  enableMcp: z.boolean().optional().default(false),
  provider: z.enum(['auto', 'modal', 'azure', 'aws']).optional().default('auto'),
});

const DeploymentIdParamSchema = z.object({
  deploymentId: z.string().uuid('Invalid deployment ID format'),
});

type DeployRequest = z.infer<typeof DeployRequestSchema>;

function buildLifecycleLogs(deployment: DeploymentRecord): DeploymentLogEntry[] {
  const logs: DeploymentLogEntry[] = [];
  const startMs = deployment.startTime;

  logs.push({
    timestamp: new Date(startMs).toISOString(),
    level: 'info',
    message: `Deployment ${deployment.deploymentId} initiated`,
  });
  logs.push({
    timestamp: new Date(startMs + 100).toISOString(),
    level: 'info',
    message: `Worker ${deployment.workerId} acquired`,
  });
  logs.push({
    timestamp: new Date(startMs + 500).toISOString(),
    level: 'info',
    message: `Agent ${deployment.agentId} deploying to worker`,
  });

  if (deployment.status === 'running') {
    logs.push({
      timestamp: new Date(startMs + deployment.estimatedTime).toISOString(),
      level: 'info',
      message: 'Health check passed — agent is live',
    });
  }

  if (deployment.status === 'failed' && deployment.error) {
    logs.push({
      timestamp: new Date(startMs + deployment.estimatedTime).toISOString(),
      level: 'error',
      message: deployment.error,
    });
  }

  return logs;
}

let redisRegistry: RedisWeightRegistry;
let imageLayerCache: ImageLayerCache;

export async function deploymentRoutes(
  fastify: FastifyInstance,
  orchestrator: Orchestrator,
): Promise<void> {
  // Initialize Redis registry for weight + image layer cache
  const initStart = Date.now();
  try {
    redisRegistry = new RedisWeightRegistry();
    imageLayerCache = new ImageLayerCache(redisRegistry);
    logger.info(`✓ Weight cache registry initialized (${Date.now() - initStart}ms)`);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.warn(`Weight cache not available, deployment will proceed without caching: ${err}`);
  }
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
          blueprintJson,
          gpuCount,
          enableMcp,
          provider: preferredProvider,
        } = validatedData;

        const deploymentId = uuidv4();
        const agentId = uuidv4();
        const userEmail = (request.user as { email?: string } | undefined)?.email;

        if (userEmail) {
          deployTelemetry.trackEventAsync({
            email: userEmail,
            eventName: 'deploy_started',
            properties: {
              framework: blueprintJson.framework?.framework ?? 'unknown',
              gpuCount,
            },
          });
        }

        logger.info(
          `Starting deployment: deploymentId=${deploymentId}, framework=${blueprintJson.framework?.framework}, gpus=${gpuCount}, provider=${preferredProvider}`,
        );

        const gpuType = ModalAppDeployer.selectGPU(
          blueprintJson.deploymentConfig?.gpuMemoryGB ?? 24,
        );

        // KRI-19: S3-backed image layer cache lookup
        const cacheStartTime = Date.now();
        let cachedImageRef: string | null = null;
        const deployConfig: Record<string, unknown> = {};

        try {
          if (imageLayerCache) {
            cachedImageRef = await imageLayerCache.lookup(blueprintJson as BlueprintJSON);
          }
        } catch (error) {
          logger.warn(`Cache lookup failed, will proceed without cache: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (cachedImageRef) {
          logger.info(`✓ Image layer cache hit for ${blueprintJson.framework?.framework}:${blueprintJson.framework?.version}`);
          deployConfig.skipPipInstall = true;
          deployConfig.cachedImageRef = cachedImageRef;
        } else {
          logger.info(`○ Image layer cache miss for ${blueprintJson.framework?.framework}:${blueprintJson.framework?.version}`);
          deployConfig.skipPipInstall = false;
        }

        // Skip sandbox acquisition entirely
        // modal deploy handles GPU allocation
        let endpointUrl: string | undefined;
        let appName: string | undefined;
        let modalError: string | undefined;
        let imageRef: string | undefined;
        let deployProvider: string | undefined;

        try {
          const result = await orchestrator.deployPersistentWithFallback(
            deploymentId,
            blueprintJson as BlueprintJSON,
            { ...deployConfig, gpuCount, enableMcp },
            preferredProvider,
          );
          endpointUrl = result.endpointUrl;
          appName = result.appName;
          imageRef = result.imageRef || result.appName || result.endpointUrl;
          deployProvider = result.provider;

          const deployTime = Date.now() - startTime;
          logger.info(
            `✓ Persistent endpoint deployed via ${deployProvider} in ${deployTime}ms: ${endpointUrl}`,
          );

          // Cache image layer on success if not already cached
          if (endpointUrl && !cachedImageRef && imageRef && imageLayerCache) {
            try {
              await imageLayerCache.register(blueprintJson as BlueprintJSON, imageRef);
            } catch (error) {
              logger.warn(`Failed to cache image layer: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          modalError = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`Deploy failed: ${modalError}`, {
            deploymentId,
            blueprintFramework: blueprintJson.framework?.framework,
            preferredProvider,
            hasModalTokens: !!(config.modal_token_id && config.modal_token_secret),
            hasAzureCreds: !!(config.azure_client_id && config.azure_subscription_id),
          });
        }

        const deployTime = Date.now() - startTime;
        const cacheStatus = cachedImageRef ? 'HIT' : 'MISS';
        logger.info(`Deploy completed in ${deployTime}ms (cache: ${cacheStatus}, lookup: ${Date.now() - cacheStartTime}ms)`);

        let mcpCard: Record<string, unknown> | undefined;
        let claudeConfig: ClaudeDesktopConfig | undefined;

        if (enableMcp && endpointUrl) {
          const card = generateMcpServerCard({
            deploymentId,
            endpointUrl,
            agentName: blueprintJson.framework?.framework,
          });
          mcpCard = card as unknown as Record<string, unknown>;
          claudeConfig = generateClaudeDesktopConfig({
            deploymentId,
            endpointUrl,
            agentName: blueprintJson.framework?.framework,
          });
        }

        // Store in Redis via orchestrator
        const deployment = {
          deploymentId,
          agentId,
          workerId: `${(deployProvider ?? 'modal').toLowerCase()}-${deploymentId}`,
          status: endpointUrl ? 'running' : 'failed',
          startTime: Date.now(),
          estimatedTime: deployTime,
          blueprintId: validatedData.blueprintId,
          lockfilePath: validatedData.lockfilePath,
          environmentHash: validatedData.environmentHash,
          endpointUrl,
          appName,
          endpointStatus: endpointUrl ? 'live' as const : 'failed' as const,
          error: modalError,
          gpuCount,
          gpuType,
          mcpEnabled: enableMcp && !!endpointUrl,
          mcpCard,
        } satisfies DeploymentRecord;

        await orchestrator.saveDeploymentRecord(deployment);

        if (userEmail) {
          const eventName = endpointUrl ? 'deploy_succeeded' : 'deploy_failed';
          deployTelemetry.trackEventAsync({
            email: userEmail,
            eventName,
            properties: {
              deploymentId,
              framework: blueprintJson.framework?.framework ?? 'unknown',
              deployTimeMs: deployTime,
              gpuType,
              gpuCount,
              cacheHit: !!cachedImageRef,
            },
          });
        }

        return reply.code(endpointUrl ? 201 : 500).send({
          success: !!endpointUrl,
          deploymentId,
          agentId,
          status: endpointUrl ? 'running' : 'failed',
          endpoint_url: endpointUrl ?? null,
          endpoint_status: endpointUrl ? 'live' : 'failed',
          modal_deployment_error: modalError ?? null,
          provider: deployProvider ?? preferredProvider,
          framework: blueprintJson.framework?.framework,
          gpuCount,
          deployTime: `${deployTime}ms`,
          mcp_enabled: enableMcp && !!endpointUrl,
          mcp_card: mcpCard ?? null,
          claude_desktop_config: claudeConfig ?? null,
          claude_desktop_config_json: claudeConfig
            ? serializeClaudeDesktopConfig(claudeConfig)
            : null,
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

        const deployment = await orchestrator.getDeploymentRecord(deploymentId);
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
            endpointUrl: deployment.endpointUrl,
            appName: deployment.appName,
            endpoint_status: deployment.endpointStatus ?? (deployment.endpointUrl ? 'live' : 'pending'),
            gpuCount: deployment.gpuCount ?? 1,
          });
        }

        const responseTime = Date.now() - startTime;
        logger.info(`✓ Status retrieved in ${responseTime}ms: deploymentId=${deploymentId}`);
        const responseStatus = deployment.endpointStatus === 'live'
          ? agentStatus.status
          : deployment.status;

        return reply.code(200).send({
          success: true,
          deploymentId,
          agentId: agentStatus.agentId,
          workerId: agentStatus.workerId,
          status: responseStatus,
          startTime: agentStatus.startTime,
          latency: responseTime,
          endpointUrl: deployment.endpointUrl,
          appName: deployment.appName,
          endpoint_status: deployment.endpointStatus ?? (deployment.endpointUrl ? 'live' : 'pending'),
          gpuCount: deployment.gpuCount ?? 1,
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

        const deployment = await orchestrator.getDeploymentRecord(deploymentId);
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

        // Stop Modal app (KRI-15: best-effort, no sandbox to release)
        const startTime = Date.now();
        if (deployment.workerId.startsWith('modal-')) {
          try {
            await orchestrator.stopPersistentModal(deploymentId);
            logger.info(`✓ Modal app stopped: ${deploymentId}`);
          } catch (error) {
            logger.warn(
              `Modal stop failed (best effort): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          try {
            await orchestrator.releaseWorker(deployment.workerId);
            logger.info(`✓ Worker released: ${deployment.workerId}`);
          } catch (error) {
            logger.warn(
              `Worker release failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        try {
          await orchestrator.terminateAgent(deployment.agentId);
        } catch (error) {
          logger.warn(
            `Agent terminate failed (best effort): ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Remove deployment record + active registration
        await orchestrator.deleteDeploymentRecord(deploymentId);

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
   * GET /api/v1/deployment/:deploymentId/logs
   * Get deployment logs
   */
  fastify.get<{ Params: unknown }>(
    '/api/v1/deployment/:deploymentId/logs',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const params = request.params as Record<string, string>;
        const { deploymentId } = DeploymentIdParamSchema.parse(params);

        const deployment = await orchestrator.getDeploymentRecord(deploymentId);
        if (!deployment) {
          logger.warn(`Deployment not found for logs: ${deploymentId}`);
          return reply.code(404).send({
            success: false,
            error: 'Deployment not found',
            deploymentId,
          });
        }

        const start = Date.now();
        const lifecycleLogs = buildLifecycleLogs(deployment);
        const containerLogs = await orchestrator.getContainerLogs(deployment);
        const logs = [...lifecycleLogs, ...containerLogs];

        logger.info(
          `✓ Deployment logs retrieved in ${Date.now() - start}ms: deploymentId=${deploymentId}, total=${logs.length}`,
        );

        return reply.code(200).send({
          success: true,
          deploymentId,
          logs,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Invalid deployment ID format',
          });
        }

        const err = error instanceof DeploymentError ? error : new DeploymentError(
          error instanceof Error ? error.message : 'Failed to get deployment logs',
        );

        logger.error(`Logs lookup error: ${err.message}`);
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

        let records: DeploymentRecord[] = [];
        try {
          records = await orchestrator.listDeploymentRecords();
        } catch (error) {
          logger.warn(
            `Failed to list deployment records: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }

        const agents = await Promise.all(
          records.map(async (dep) => {
            let gpuUtilization: number | null = null;
            let status = dep.status;
            try {
              const live = await orchestrator.getDeploymentStatus(dep.agentId);
              gpuUtilization = live.gpuUtilization ?? null;
              status = live.status;
            } catch {
              // Use cached record values
            }

            return {
              deploymentId: dep.deploymentId,
              agentId: dep.agentId,
              status,
              gpuType: dep.gpuType ?? 'T4',
              gpuCount: dep.gpuCount ?? 1,
              uptime: dep.startTime ? Date.now() - dep.startTime : 0,
              gpuUtilization,
              workerId: dep.workerId,
              endpointUrl: dep.endpointUrl ?? null,
            };
          }),
        );

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

  /**
   * DELETE /api/v1/deployment/:deploymentId/stop-modal
   * Stop a persistent Modal app deployment
   */
  fastify.delete<{ Params: unknown }>(
    '/api/v1/deployment/:deploymentId/stop-modal',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const params = request.params as Record<string, string>;
        const { deploymentId } = DeploymentIdParamSchema.parse(params);

        const deployment = await orchestrator.getDeploymentRecord(deploymentId);
        if (!deployment) {
          logger.warn(`Deployment not found: ${deploymentId}`);
          return reply.code(404).send({
            success: false,
            error: 'Deployment not found',
            deploymentId,
          });
        }

        if (!deployment.appName) {
          logger.warn(`No Modal app found for deployment: ${deploymentId}`);
          return reply.code(400).send({
            success: false,
            error: 'No Modal app deployed for this deployment',
            deploymentId,
          });
        }

        // Stop the persistent Modal app
        const startTime = Date.now();
        try {
          await orchestrator.stopPersistentModal(deploymentId);

          deployment.endpointUrl = undefined;
          deployment.appName = undefined;
          deployment.endpointStatus = 'pending';
          await orchestrator.saveDeploymentRecord(deployment);

          const stopTime = Date.now() - startTime;
          logger.info(`✓ Modal app stopped in ${stopTime}ms: ${deploymentId}`);

          return reply.code(200).send({
            success: true,
            deploymentId,
            message: 'Modal app stopped successfully',
            stoppedAt: Date.now(),
          });
        } catch (error) {
          const err = error instanceof DeploymentError ? error : new DeploymentError(
            error instanceof Error ? error.message : 'Failed to stop Modal app',
            { deploymentId },
          );

          logger.error(`Failed to stop Modal app: ${err.message}`);
          return reply.code(err.statusCode || 500).send({
            success: false,
            error: err.message,
            deploymentId,
          });
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          logger.warn(`Validation error: ${error.message}`);
          return reply.code(400).send({
            success: false,
            error: 'Invalid parameters',
            details: error.errors,
          });
        }

        const err = error instanceof DeploymentError ? error : new DeploymentError(
          error instanceof Error ? error.message : 'Internal server error',
        );

        logger.error(`Stop Modal error: ${err.message}`);
        return reply.code(err.statusCode || 500).send({
          success: false,
          error: err.message,
        });
      }
    },
  );

  /**
   * GET /api/v1/deployment/:deploymentId/mcp/card
   * MCP server card discovery
   */
  fastify.get<{ Params: unknown }>(
    '/api/v1/deployment/:deploymentId/mcp/card',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const params = request.params as Record<string, string>;
        const { deploymentId } = DeploymentIdParamSchema.parse(params);
        const deployment = await orchestrator.getDeploymentRecord(deploymentId);

        if (!deployment?.mcpEnabled || !deployment.endpointUrl) {
          return reply.code(404).send({
            success: false,
            error: 'MCP not enabled for this deployment',
            deploymentId,
          });
        }

        const card = deployment.mcpCard ?? generateMcpServerCard({
          deploymentId,
          endpointUrl: deployment.endpointUrl,
        });

        return reply
          .header('Content-Type', 'application/json')
          .code(200)
          .send(card);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ success: false, error: 'Invalid deployment ID' });
        }
        throw error;
      }
    },
  );

  /**
   * GET /api/v1/deployment/:deploymentId/mcp/config
   * Claude Desktop copy-paste config
   */
  fastify.get<{ Params: unknown }>(
    '/api/v1/deployment/:deploymentId/mcp/config',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const params = request.params as Record<string, string>;
        const { deploymentId } = DeploymentIdParamSchema.parse(params);
        const deployment = await orchestrator.getDeploymentRecord(deploymentId);

        if (!deployment?.mcpEnabled || !deployment.endpointUrl) {
          return reply.code(404).send({
            success: false,
            error: 'MCP not enabled for this deployment',
            deploymentId,
          });
        }

        const config = generateClaudeDesktopConfig({
          deploymentId,
          endpointUrl: deployment.endpointUrl,
        });

        return reply.code(200).send({
          success: true,
          deploymentId,
          config,
          config_json: serializeClaudeDesktopConfig(config),
          install_path: '~/Library/Application Support/Claude/claude_desktop_config.json',
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ success: false, error: 'Invalid deployment ID' });
        }
        throw error;
      }
    },
  );

  /**
   * GET /.well-known/mcp/:deploymentId.json
   * Public MCP card discovery (no auth — card contains only public endpoint URLs)
   */
  fastify.get<{ Params: unknown }>(
    '/.well-known/mcp/:deploymentId.json',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const params = request.params as Record<string, string>;
        const { deploymentId } = DeploymentIdParamSchema.parse(params);
        const deployment = await orchestrator.getDeploymentRecord(deploymentId);

        if (!deployment?.mcpEnabled || !deployment.endpointUrl) {
          return reply.code(404).send({ error: 'MCP card not found' });
        }

        const card = deployment.mcpCard ?? generateMcpServerCard({
          deploymentId,
          endpointUrl: deployment.endpointUrl,
        });

        return reply
          .header('Content-Type', 'application/json')
          .code(200)
          .send(card);
      } catch {
        return reply.code(404).send({ error: 'MCP card not found' });
      }
    },
  );
}

export default deploymentRoutes;
