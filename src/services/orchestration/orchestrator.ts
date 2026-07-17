import { v4 as uuidv4 } from 'uuid';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { BlueprintJSON } from '../../types/blueprint.types';
import {
  DeploymentLogStore,
  DeploymentLogEntry,
  DeploymentLogRedisClient,
} from './deploymentLogStore';
import {
  resolvePersistentProviderOrder,
  shouldFallbackToAzure,
  type PersistentDeployProvider,
} from './deployProviderFallback';
import { mapPool } from './parallel';

const DEPLOYMENT_STATE_PREFIX = 'orchestration:deployment:';
const ACTIVE_DEPLOYMENTS_KEY = 'orchestration:active-deployments';
const DEPLOYMENT_RECORD_PREFIX = 'deployment:';
const DEPLOYMENT_RECORDS_KEY = 'deployments:all';
const HEALTH_CHECK_TIMEOUT_MS = 60000;
const DEPLOYMENT_TIMEOUT_MS = 300000;

export interface GPUProvider {
  name: string;
  acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null>;
  releaseWorker(workerId: string): Promise<void>;
  healthCheck(workerId: string): Promise<boolean>;
  getGpuUtilization(workerId: string): Promise<number | null>;
}

export interface WorkerRequirements {
  minGPUMemory: number;
  framework: string;
  pythonVersion: string;
  secureRuntime?: boolean;
  /** Number of GPUs to allocate (1-8, default 1). */
  gpuCount?: number;
}

export interface WorkerInfo {
  workerId: string;
  gpuId: string;
  ipAddress: string;
  port: number;
  gpuMemoryGB: number;
  availableGPUMemory: number;
  provider: string;
  secureRuntimeActive: boolean;
}

export interface DeploymentStatus {
  agentId: string;
  workerId: string;
  status: 'pending' | 'deploying' | 'running' | 'failed';
  startTime: number;
  containerImage: string;
  gpuUtilization?: number | null;
  lastActivityAt: number;
  error?: string;
}

export interface DeploymentRecord {
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
  endpointUrl?: string;
  appName?: string;
  endpointStatus?: 'pending' | 'live' | 'failed';
  /** Number of GPUs allocated for this deployment (1-8). */
  gpuCount?: number;
  /** GPU type selected for this deployment (e.g. T4, L4, A100). */
  gpuType?: string;
  /** MCP server enabled for this deployment */
  mcpEnabled?: boolean;
  /** Discoverable MCP server card JSON */
  mcpCard?: Record<string, unknown>;
}

interface StoredDeployment {
  agentId: string;
  workerId: string;
  status: 'pending' | 'deploying' | 'running' | 'failed';
  startTime: number;
  containerImage: string;
  gpuUtilization?: number | null;
  lastActivityAt: number;
  error?: string;
}

export interface RedisClient {
  isOpen: boolean;
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<number>;
  sAdd(key: string, member: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  rPush(key: string, ...values: string[]): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, seconds: number): Promise<boolean>;
  lTrim(key: string, start: number, stop: number): Promise<string>;
}

interface ModalLogCapableProvider {
  name: string;
  fetchPersistentAppLogs?(deploymentId: string): Promise<{ stdout: string; stderr: string }>;
  fetchSandboxLogs?(workerId: string): Promise<{ stdout: string; stderr: string }>;
}

export class Orchestrator {
  private readonly providers: GPUProvider[];
  private readonly redisClient: RedisClient;
  private readonly logStore: DeploymentLogStore;

  constructor(providers: GPUProvider[], redisClient: RedisClient) {
    this.providers = providers;
    this.redisClient = redisClient;
    this.logStore = new DeploymentLogStore(redisClient as unknown as DeploymentLogRedisClient);
  }

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo> {
    const start = Date.now();

    try {
      await this.ensureConnected();

      logger.info(
        `Acquiring worker (parallel): framework=${requirements.framework}, python=${requirements.pythonVersion}, minGPU=${requirements.minGPUMemory}GB`,
      );

      // Query all providers in parallel; pick highest available GPU memory.
      const settled = await Promise.all(
        this.providers.map(async (provider) => {
          try {
            return await provider.acquireWorker(requirements);
          } catch {
            return null;
          }
        }),
      );

      const workers = settled.filter((w): w is WorkerInfo => w != null);
      if (workers.length === 0) {
        throw new DeploymentError('No available workers matching requirements', {
          requirements,
        });
      }

      workers.sort((a, b) => b.availableGPUMemory - a.availableGPUMemory);
      const bestWorker = workers[0];

      // Release over-acquired workers from parallel probe.
      await Promise.all(
        workers.slice(1).map(async (extra) => {
          for (const provider of this.providers) {
            try {
              await provider.releaseWorker(extra.workerId);
              return;
            } catch {
              continue;
            }
          }
        }),
      );

      logger.info(`✓ Worker acquired in ${Date.now() - start}ms: ${bestWorker.workerId}`);
      return bestWorker;
    } catch (error: unknown) {
      throw this.toDeploymentError('Worker acquisition failed', { requirements }, error);
    }
  }

  async releaseWorker(workerId: string): Promise<void> {
    const start = Date.now();

    try {
      await this.ensureConnected();

      logger.info(`Releasing worker: ${workerId}`);

      for (const provider of this.providers) {
        try {
          await provider.releaseWorker(workerId);
          logger.info(`✓ Worker released in ${Date.now() - start}ms: ${workerId}`);
          return;
        } catch {
          // Try next provider
          continue;
        }
      }

      logger.warn(`Worker release: worker not found in any provider: ${workerId}`);
    } catch (error: unknown) {
      throw this.toDeploymentError('Worker release failed', { workerId }, error);
    }
  }

  async deployAgent(
    workerId: string,
    blueprint: BlueprintJSON,
    _lockfilePath: string,
    environmentHash: string,
  ): Promise<{ agentId: string; status: string; deploymentTime: number }> {
    const start = Date.now();
    const deployTimeout = Date.now() + DEPLOYMENT_TIMEOUT_MS;
    const agentId = uuidv4();

    try {
      await this.ensureConnected();

      logger.info(`Deploying agent to worker ${workerId}: agentId=${agentId}`);

      // Validate inputs
      if (!blueprint.id) {
        throw new DeploymentError('Blueprint missing ID', { blueprintId: blueprint.id });
      }
      if (!environmentHash) {
        throw new DeploymentError('Environment hash required', { environmentHash });
      }

      // Find the worker's provider
      let workerProvider: GPUProvider | null = null;
      for (const provider of this.providers) {
        try {
          const isHealthy = await provider.healthCheck(workerId);
          if (isHealthy) {
            workerProvider = provider;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!workerProvider) {
        throw new DeploymentError('Worker not found or unhealthy', { workerId });
      }

      // Create deployment record
      const deployment: StoredDeployment = {
        agentId,
        workerId,
        status: 'pending',
        startTime: Date.now(),
        lastActivityAt: Date.now(),
        containerImage: `${blueprint.systemRequirements.baseImageId}:${blueprint.systemRequirements.baseImageTag}`,
      };

      const deploymentKey = this.deploymentKey(agentId);
      await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
        EX: 86400, // 24 hours
      });
      await this.redisClient.sAdd(ACTIVE_DEPLOYMENTS_KEY, agentId);

      logger.info(`Deployment record created: ${agentId} (status=pending)`);

      // Simulate deployment stages with checks
      if (Date.now() > deployTimeout) {
        deployment.status = 'failed';
        deployment.error = 'Deployment exceeded timeout';
        deployment.lastActivityAt = Date.now();
        await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
          EX: 86400,
        });
        throw new DeploymentError('Deployment exceeded timeout', { timeout: DEPLOYMENT_TIMEOUT_MS });
      }

      // Update to deploying
      deployment.status = 'deploying';
      deployment.lastActivityAt = Date.now();
      await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
        EX: 86400,
      });
      logger.info(`Deployment updated: ${agentId} (status=deploying)`);

      // Perform health check with timeout
      const healthCheckStart = Date.now();
      let healthCheckPassed = false;
      let lastHealthCheckError: string | null = null;

      while (Date.now() - healthCheckStart < HEALTH_CHECK_TIMEOUT_MS) {
        if (Date.now() > deployTimeout) {
          throw new DeploymentError('Deployment exceeded timeout during health check', {
            timeout: DEPLOYMENT_TIMEOUT_MS,
          });
        }

        try {
          healthCheckPassed = await workerProvider.healthCheck(workerId);
          if (healthCheckPassed) {
            break;
          }
        } catch (error: unknown) {
          lastHealthCheckError = error instanceof Error ? error.message : String(error);
          await this.sleep(500);
        }
      }

      if (!healthCheckPassed) {
        deployment.status = 'failed';
        deployment.error = lastHealthCheckError || 'Health check failed';
        deployment.lastActivityAt = Date.now();
        await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
          EX: 86400,
        });
        throw new DeploymentError('Agent failed health check', {
          workerId,
          agentId,
          cause: lastHealthCheckError,
        });
      }

      // Update to running
      deployment.status = 'running';
      deployment.lastActivityAt = Date.now();
      await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
        EX: 86400,
      });

      const deploymentTime = Date.now() - start;
      logger.info(`✓ Agent deployed in ${deploymentTime}ms: agentId=${agentId}, status=running`);

      return {
        agentId,
        status: 'running',
        deploymentTime,
      };
    } catch (error: unknown) {
      // Ensure deployment is marked as failed
      const deploymentKey = this.deploymentKey(agentId);
      try {
        const existingDeployment = await this.redisClient.get(deploymentKey);
        const deployment = existingDeployment ? JSON.parse(existingDeployment) as StoredDeployment : {
          agentId,
          workerId,
          status: 'failed' as const,
          startTime: Date.now(),
          lastActivityAt: Date.now(),
          containerImage: blueprint.systemRequirements?.baseImageId || 'unknown',
        };
        deployment.status = 'failed';
        deployment.lastActivityAt = Date.now();
        deployment.error = error instanceof Error ? error.message : String(error);
        await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
          EX: 86400,
        });
      } catch {
        // Ignore errors updating failure state
      }

      throw this.toDeploymentError('Agent deployment failed', {
        workerId,
        agentId,
        blueprintId: blueprint.id,
      }, error);
    }
  }

  async getDeploymentStatus(agentId: string): Promise<DeploymentStatus> {
    try {
      await this.ensureConnected();

      const deploymentKey = this.deploymentKey(agentId);
      const payload = await this.redisClient.get(deploymentKey);

      if (!payload) {
        throw new DeploymentError('Deployment not found', { agentId });
      }

      const deployment = JSON.parse(payload) as StoredDeployment;

      // Do not refresh lastActivityAt here — status polls must not reset idle timers
      // (scale-to-zero reaper). Real traffic should call touchDeploymentActivity().
      if (deployment.status === 'running') {
        deployment.gpuUtilization = await this.fetchGpuUtilization(deployment.workerId);
        await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
          EX: 86400,
        });
      }

      return deployment;
    } catch (error: unknown) {
      throw this.toDeploymentError('Failed to get deployment status', { agentId }, error);
    }
  }

  /**
   * Mark a deployment as recently active (real request/traffic).
   * Status polling must not call this — only live agent traffic.
   */
  async touchDeploymentActivity(agentId: string): Promise<void> {
    try {
      await this.ensureConnected();

      const deploymentKey = this.deploymentKey(agentId);
      const payload = await this.redisClient.get(deploymentKey);

      if (!payload) {
        throw new DeploymentError('Deployment not found', { agentId });
      }

      const deployment = JSON.parse(payload) as StoredDeployment;
      deployment.lastActivityAt = Date.now();
      await this.redisClient.set(deploymentKey, JSON.stringify(deployment), {
        EX: 86400,
      });
    } catch (error: unknown) {
      throw this.toDeploymentError('Failed to touch deployment activity', { agentId }, error);
    }
  }

  async terminateAgent(agentId: string): Promise<void> {
    try {
      await this.ensureConnected();
      logger.info(`Terminating agent: ${agentId}`);

      const status = await this.getDeploymentStatus(agentId);
      await this.releaseWorker(status.workerId);

      await this.redisClient.del(this.deploymentKey(agentId));
      await this.redisClient.sRem(ACTIVE_DEPLOYMENTS_KEY, agentId);

      logger.info(`✓ Agent terminated: ${agentId}`);
    } catch (error: unknown) {
      throw this.toDeploymentError('Failed to terminate agent', { agentId }, error);
    }
  }

  async cleanupIdleDeployments(idleThresholdMs: number): Promise<number> {
    const start = Date.now();
    let terminatedCount = 0;

    try {
      await this.ensureConnected();
      const agentIds = await this.redisClient.sMembers(ACTIVE_DEPLOYMENTS_KEY);

      const outcomes = await mapPool(agentIds, 8, async (agentId) => {
        try {
          const status = await this.getDeploymentStatus(agentId);
          const idleTime = Date.now() - status.lastActivityAt;

          if (idleTime > idleThresholdMs) {
            logger.info(
              `Scale-to-Zero: Terminating idle agent ${agentId} (Idle for ${Math.round(idleTime / 1000)}s)`,
            );
            await this.terminateAgent(agentId);
            return 1;
          }
          return 0;
        } catch (error) {
          logger.error(`Failed to cleanup agent ${agentId}:`, error);
          return 0;
        }
      });
      terminatedCount = outcomes.reduce<number>((sum, n) => sum + n, 0);

      if (terminatedCount > 0) {
        logger.info(`✓ Scale-to-Zero: Terminated ${terminatedCount} idle agents in ${Date.now() - start}ms`);
      }
      return terminatedCount;
    } catch (error: unknown) {
      logger.error('Failed to run idle cleanup:', error);
      return 0;
    }
  }

  async listDeployments(): Promise<DeploymentStatus[]> {
    const start = Date.now();

    try {
      await this.ensureConnected();

      const agentIds = await this.redisClient.sMembers(ACTIVE_DEPLOYMENTS_KEY);
      const settled = await mapPool(agentIds, 16, async (agentId) => {
        try {
          return await this.getDeploymentStatus(agentId);
        } catch {
          return null;
        }
      });
      const deployments = settled.filter((d): d is DeploymentStatus => d != null);

      logger.info(`✓ Listed ${deployments.length} deployments in ${Date.now() - start}ms`);
      return deployments;
    } catch (error: unknown) {
      throw this.toDeploymentError('Failed to list deployments', {}, error);
    }
  }

  async deployPersistentModal(
    deploymentId: string,
    blueprint: BlueprintJSON,
    deployConfig?: {
      skipPipInstall?: boolean;
      cachedImageRef?: string;
      gpuCount?: number;
      enableMcp?: boolean;
      projectPath?: string;
    },
  ): Promise<{ endpointUrl: string; appName: string; imageRef: string; deploymentTime: number }> {
    const start = Date.now();

    try {
      await this.ensureConnected();

      logger.info(
        `Deploying persistent Modal app: deploymentId=${deploymentId}, framework=${blueprint.framework.framework}`,
      );

      // Find Modal provider
      let modalProvider: PersistentDeployProvider | null = null;
      for (const provider of this.providers) {
        if (provider.name === 'Modal' && 'deployPersistentApp' in provider) {
          modalProvider = provider as GPUProvider & PersistentDeployProvider;
          break;
        }
      }

      if (!modalProvider) {
        throw new DeploymentError('Modal provider not available');
      }

      // Deploy the persistent app
      const result = await modalProvider.deployPersistentApp(deploymentId, blueprint, deployConfig);

      const deploymentTime = Date.now() - start;
      logger.info(`✓ Persistent Modal app deployed in ${deploymentTime}ms: ${result.endpointUrl}`);

      return {
        ...result,
        deploymentTime,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorDetails = error instanceof DeploymentError ? error.details : {};
      logger.error(
        `Modal persistent deployment failed: ${errorMessage}`,
        {
          deploymentId,
          error: errorMessage,
          details: errorDetails,
        },
      );
      throw this.toDeploymentError(
        'Failed to deploy persistent Modal app',
        { deploymentId, originalError: errorMessage },
        error,
      );
    }
  }

  /**
   * Deploy persistent endpoint with multi-provider fallback (Modal → Azure → AWS).
   */
  async deployPersistentWithFallback(
    deploymentId: string,
    blueprint: BlueprintJSON,
    deployConfig?: {
      skipPipInstall?: boolean;
      cachedImageRef?: string;
      gpuCount?: number;
      enableMcp?: boolean;
      projectPath?: string;
    },
    preferredProvider?: string,
  ): Promise<{
    endpointUrl: string;
    appName: string;
    imageRef: string;
    deploymentTime: number;
    provider: string;
  }> {
    const start = Date.now();

    try {
      await this.ensureConnected();

      const persistentProviders = this.providers.filter(
        (p): p is GPUProvider & PersistentDeployProvider =>
          'deployPersistentApp' in p && typeof (p as PersistentDeployProvider).deployPersistentApp === 'function',
      ) as PersistentDeployProvider[];

      if (persistentProviders.length === 0) {
        throw new DeploymentError('No persistent deploy providers available');
      }

      const ordered = resolvePersistentProviderOrder(persistentProviders, preferredProvider);
      const hasAzure = persistentProviders.some((p) => p.name.toLowerCase() === 'azure');
      const errors: string[] = [];

      for (const provider of ordered) {
        try {
          logger.info(`Attempting persistent deploy via ${provider.name}`);
          const result = await provider.deployPersistentApp(deploymentId, blueprint, deployConfig);
          const deploymentTime = Date.now() - start;
          logger.info(
            `✓ Persistent app deployed via ${provider.name} in ${deploymentTime}ms: ${result.endpointUrl}`,
          );
          return { ...result, deploymentTime, provider: provider.name };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`${provider.name}: ${errorMessage}`);

          if (shouldFallbackToAzure(provider.name, error, hasAzure)) {
            logger.warn(`Modal rate limited (429) — falling back to Azure`);
            continue;
          }

          if (preferredProvider && preferredProvider !== 'auto') {
            throw this.toDeploymentError(
              `Failed to deploy via ${provider.name}`,
              { deploymentId, provider: provider.name, originalError: errorMessage },
              error,
            );
          }

          logger.warn(`Provider ${provider.name} failed, trying next: ${errorMessage}`);
        }
      }

      throw new DeploymentError('All persistent deploy providers failed', {
        deploymentId,
        errors,
      });
    } catch (error: unknown) {
      if (error instanceof DeploymentError) throw error;
      throw this.toDeploymentError('Failed to deploy persistent app', { deploymentId }, error);
    }
  }

  async stopPersistentModal(deploymentId: string): Promise<void> {
    const start = Date.now();

    try {
      await this.ensureConnected();

      // Find Modal provider
      type StopPersistentProvider = { stopPersistentApp(deploymentId: string): Promise<void> };
      let modalProvider: StopPersistentProvider | null = null;
      for (const provider of this.providers) {
        if (provider.name === 'Modal' && 'stopPersistentApp' in provider) {
          modalProvider = provider as GPUProvider & StopPersistentProvider;
          break;
        }
      }

      if (!modalProvider) {
        throw new DeploymentError('Modal provider not available');
      }

      await modalProvider.stopPersistentApp(deploymentId);

      logger.info(`✓ Persistent Modal app stopped in ${Date.now() - start}ms: ${deploymentId}`);
    } catch (error: unknown) {
      throw this.toDeploymentError(
        'Failed to stop persistent Modal app',
        { deploymentId },
        error,
      );
    }
  }

  private async fetchGpuUtilization(workerId: string): Promise<number | null> {
    for (const provider of this.providers) {
      try {
        const isHealthy = await provider.healthCheck(workerId);
        if (!isHealthy) {
          continue;
        }

        return await provider.getGpuUtilization(workerId);
      } catch {
        continue;
      }
    }

    return null;
  }

  private deploymentKey(agentId: string): string {
    return `${DEPLOYMENT_STATE_PREFIX}${agentId}`;
  }

  private deploymentRecordKey(deploymentId: string): string {
    return `${DEPLOYMENT_RECORD_PREFIX}${deploymentId}`;
  }

  async saveDeploymentRecord(record: DeploymentRecord): Promise<void> {
    await this.ensureConnected();
    await this.redisClient.set(this.deploymentRecordKey(record.deploymentId), JSON.stringify(record), {
      EX: 86400,
    });
    await this.redisClient.sAdd(DEPLOYMENT_RECORDS_KEY, record.deploymentId);
    await this.registerActiveDeployment(record);
  }

  /**
   * Register a deployment in the active set so listDeployments() and /agents work for Modal deploys.
   */
  async registerActiveDeployment(record: DeploymentRecord): Promise<void> {
    const deployment: StoredDeployment = {
      agentId: record.agentId,
      workerId: record.workerId,
      status: record.status,
      startTime: record.startTime,
      lastActivityAt: Date.now(),
      containerImage: record.appName ?? `modal-${record.deploymentId}`,
    };

    await this.redisClient.set(this.deploymentKey(record.agentId), JSON.stringify(deployment), {
      EX: 86400,
    });
    await this.redisClient.sAdd(ACTIVE_DEPLOYMENTS_KEY, record.agentId);
  }

  async unregisterActiveDeployment(agentId: string): Promise<void> {
    await this.ensureConnected();
    await this.redisClient.del(this.deploymentKey(agentId));
    await this.redisClient.sRem(ACTIVE_DEPLOYMENTS_KEY, agentId);
  }

  async getDeploymentRecord(deploymentId: string): Promise<DeploymentRecord | null> {
    await this.ensureConnected();
    const payload = await this.redisClient.get(this.deploymentRecordKey(deploymentId));
    if (!payload) {
      return null;
    }

    return JSON.parse(payload) as DeploymentRecord;
  }

  async deleteDeploymentRecord(deploymentId: string): Promise<void> {
    await this.ensureConnected();
    const record = await this.getDeploymentRecord(deploymentId);
    await this.redisClient.del(this.deploymentRecordKey(deploymentId));
    await this.redisClient.sRem(DEPLOYMENT_RECORDS_KEY, deploymentId);
    if (record) {
      await this.unregisterActiveDeployment(record.agentId);
    }
  }

  async listDeploymentRecords(): Promise<DeploymentRecord[]> {
    await this.ensureConnected();
    const deploymentIds = await this.redisClient.sMembers(DEPLOYMENT_RECORDS_KEY);
    const records: DeploymentRecord[] = [];

    for (const deploymentId of deploymentIds) {
      const payload = await this.redisClient.get(this.deploymentRecordKey(deploymentId));
      if (!payload) {
        continue;
      }

      records.push(JSON.parse(payload) as DeploymentRecord);
    }

    return records;
  }

  async appendDeploymentLog(deploymentId: string, entry: DeploymentLogEntry): Promise<void> {
    await this.logStore.appendLog(deploymentId, entry);
  }

  async getStoredDeploymentLogs(deploymentId: string): Promise<DeploymentLogEntry[]> {
    return this.logStore.getLogs(deploymentId);
  }

  async refreshContainerLogs(deployment: DeploymentRecord): Promise<void> {
    const start = Date.now();
    const modalProvider = this.findModalLogProvider();
    if (!modalProvider) {
      return;
    }

    const existing = await this.logStore.getLogs(deployment.deploymentId);
    const existingMessages = new Set(existing.map(log => log.message));

    let stdout = '';
    let stderr = '';

    if (deployment.workerId.startsWith('modal-') && modalProvider.fetchPersistentAppLogs) {
      const result = await modalProvider.fetchPersistentAppLogs(deployment.deploymentId);
      stdout = result.stdout;
      stderr = result.stderr;
    } else if (modalProvider.fetchSandboxLogs) {
      const result = await modalProvider.fetchSandboxLogs(deployment.workerId);
      stdout = result.stdout;
      stderr = result.stderr;
    }

    const newStdoutLines = stdout
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.length > 0 && !existingMessages.has(line));
    const newStderrLines = stderr
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.length > 0 && !existingMessages.has(line));

    await this.logStore.appendLines(deployment.deploymentId, newStdoutLines, 'stdout');
    await this.logStore.appendLines(deployment.deploymentId, newStderrLines, 'stderr');

    if (newStdoutLines.length > 0 || newStderrLines.length > 0) {
      logger.info(
        `Refreshed container logs for ${deployment.deploymentId} (+${newStdoutLines.length + newStderrLines.length} lines) in ${Date.now() - start}ms`,
      );
    }
  }

  async getContainerLogs(deployment: DeploymentRecord): Promise<DeploymentLogEntry[]> {
    try {
      await this.refreshContainerLogs(deployment);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Container log refresh failed for ${deployment.deploymentId}: ${msg}`);
    }

    return this.logStore.getLogs(deployment.deploymentId);
  }

  private findModalLogProvider(): ModalLogCapableProvider | null {
    for (const provider of this.providers) {
      if (provider.name === 'Modal') {
        return provider as ModalLogCapableProvider;
      }
    }
    return null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.redisClient.isOpen) {
      return;
    }

    try {
      await this.redisClient.connect();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : '';
      logger.error(`CRITICAL: Redis Connection Failed. URL: ${this.redisClient.isOpen ? 'OPEN' : 'CLOSED'}. Error: ${msg}`);
      if (stack) logger.error(stack);
      throw this.toDeploymentError('Redis connection failed', { cause: msg }, error);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  private toDeploymentError(
    message: string,
    details: Record<string, unknown>,
    cause: unknown,
  ): DeploymentError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new DeploymentError(message, { ...details, cause: causeMessage });
  }
}

export default Orchestrator;
