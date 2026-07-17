import { createClient } from 'redis';
import { Orchestrator, GPUProvider, WorkerInfo, WorkerRequirements, RedisClient } from './orchestrator';
import { ProviderRegistry } from './providerRegistry';
import { ModalProvider } from './providers/modalProvider';
import { AzureGPUProvider } from './providers/azureGpuProvider';
import { AWSGPUProvider } from './providers/awsGpuProvider';
import { LambdaLabsProvider } from './providers/lambdaLabsProvider';
import { config } from '../../utils/config';
import { logger } from '../../utils/logger';

class StaticGPUProvider implements GPUProvider {
  name = 'static-provider';
  private readonly busyWorkers = new Set<string>();

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null> {
    if (this.busyWorkers.size > 0) {
      return null;
    }

    const workerId = `worker-static-${Date.now()}`;
    this.busyWorkers.add(workerId);

    return {
      workerId,
      gpuId: 'gpu-static-0',
      ipAddress: '127.0.0.1',
      port: 8080,
      gpuMemoryGB: Math.max(16, requirements.minGPUMemory),
      availableGPUMemory: Math.max(16, requirements.minGPUMemory),
      provider: this.name,
      secureRuntimeActive: false,
    };
  }

  async releaseWorker(workerId: string): Promise<void> {
    this.busyWorkers.delete(workerId);
  }

  async healthCheck(_workerId: string): Promise<boolean> {
    return true;
  }

  async getGpuUtilization(_workerId: string): Promise<number | null> {
    return null;
  }
}

class ModalGPUProviderAdapter implements GPUProvider {
  name = 'Modal';
  private modal: ModalProvider;
  private initialized = false;

  constructor(modal: ModalProvider) {
    this.modal = modal;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.modal.connect({
      token_id: config.modal_token_id,
      token_secret: config.modal_token_secret,
    });
    this.initialized = true;
  }

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null> {
    try {
      await this.ensureInit();
      const worker = await this.modal.acquireGPU({
        minMemory: requirements.minGPUMemory,
        framework: requirements.framework,
        secureRuntime: requirements.secureRuntime,
        gpuCount: requirements.gpuCount,
      });

      return {
        workerId: worker.workerId,
        gpuId: worker.gpuId,
        ipAddress: worker.ipAddress,
        port: worker.port,
        gpuMemoryGB: worker.memoryGB,
        availableGPUMemory: worker.memoryGB,
        provider: this.name,
        secureRuntimeActive: worker.secureRuntimeActive,
      };
    } catch (error) {
      logger.error(`Modal worker acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async releaseWorker(workerId: string): Promise<void> {
    await this.modal.releaseGPU(workerId);
  }

  async healthCheck(_workerId: string): Promise<boolean> {
    return this.modal.healthCheck();
  }

  async getGpuUtilization(workerId: string): Promise<number | null> {
    try {
      await this.ensureInit();
      return await this.modal.getGpuUtilization(workerId);
    } catch {
      return null;
    }
  }

  async getPrice(gpuType: string): Promise<number> {
    // Guide map + env overrides; no cloud API call required.
    return this.modal.getPrice(gpuType);
  }

  async listAvailable(): Promise<
    Array<{ gpuType: string; memoryGB: number; available: boolean; pricePerHour?: number; id?: string }>
  > {
    await this.ensureInit();
    return this.modal.listAvailable();
  }

  async deployPersistentApp(
    deploymentId: string,
    blueprint: unknown,
    deployConfig?: { skipPipInstall?: boolean; cachedImageRef?: string; gpuCount?: number; enableMcp?: boolean },
  ): Promise<{ endpointUrl: string; appName: string; imageRef: string }> {
    return await this.modal.deployPersistentApp(deploymentId, blueprint as import('../../types/blueprint.types').BlueprintJSON, deployConfig);
  }

  async stopPersistentApp(deploymentId: string): Promise<void> {
    return await this.modal.stopPersistentApp(deploymentId);
  }

  async fetchPersistentAppLogs(deploymentId: string): Promise<{ stdout: string; stderr: string }> {
    return await this.modal.fetchPersistentAppLogs(deploymentId);
  }

  async fetchSandboxLogs(workerId: string): Promise<{ stdout: string; stderr: string }> {
    return await this.modal.fetchSandboxLogs(workerId);
  }

  getModal(): ModalProvider {
    return this.modal;
  }
}

class AzureGPUProviderAdapter implements GPUProvider {
  name = 'Azure';
  private azure: AzureGPUProvider;
  private initialized = false;

  constructor(azure?: AzureGPUProvider) {
    this.azure = azure ?? new AzureGPUProvider();
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.azure.connect({
      azure_tenant_id: config.azure_tenant_id,
      azure_client_id: config.azure_client_id,
      azure_client_secret: config.azure_client_secret,
      azure_subscription_id: config.azure_subscription_id,
      azure_resource_group: config.azure_resource_group,
      azure_location: config.azure_location,
      azure_storage_account: config.azure_storage_account,
    });
    this.initialized = true;
  }

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null> {
    try {
      await this.ensureInit();
      const worker = await this.azure.acquireGPU({
        minMemory: requirements.minGPUMemory,
        framework: requirements.framework,
        gpuCount: requirements.gpuCount,
      });

      return {
        workerId: worker.workerId,
        gpuId: worker.gpuId,
        ipAddress: worker.ipAddress,
        port: worker.port,
        gpuMemoryGB: worker.memoryGB,
        availableGPUMemory: worker.memoryGB,
        provider: this.name,
        secureRuntimeActive: worker.secureRuntimeActive,
      };
    } catch (error) {
      logger.error(`Azure worker acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async releaseWorker(workerId: string): Promise<void> {
    await this.ensureInit();
    await this.azure.releaseGPU(workerId);
  }

  async healthCheck(_workerId: string): Promise<boolean> {
    try {
      await this.ensureInit();
      return await this.azure.healthCheck();
    } catch {
      return false;
    }
  }

  async getGpuUtilization(_workerId: string): Promise<number | null> {
    return null;
  }

  async getPrice(gpuType: string): Promise<number> {
    await this.ensureInit();
    return this.azure.getPrice(gpuType);
  }

  async listAvailable(): Promise<
    Array<{ gpuType: string; memoryGB: number; available: boolean; pricePerHour?: number; id?: string; region?: string }>
  > {
    await this.ensureInit();
    return this.azure.listAvailable();
  }

  async deployPersistentApp(
    deploymentId: string,
    blueprint: unknown,
    deployConfig?: { skipPipInstall?: boolean; cachedImageRef?: string; gpuCount?: number; enableMcp?: boolean },
  ): Promise<{ endpointUrl: string; appName: string; imageRef: string }> {
    await this.ensureInit();
    return this.azure.deployPersistentApp(
      deploymentId,
      blueprint as import('../../types/blueprint.types').BlueprintJSON,
      deployConfig,
    );
  }

  getAzure(): AzureGPUProvider {
    return this.azure;
  }
}

class AWSGPUProviderAdapter implements GPUProvider {
  name = 'AWS';
  private aws: AWSGPUProvider;
  private initialized = false;

  constructor(aws?: AWSGPUProvider) {
    this.aws = aws ?? new AWSGPUProvider();
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.aws.connect({
      aws_access_key_id: config.aws_access_key_id,
      aws_secret_access_key: config.aws_secret_access_key,
      region: config.aws_region,
    });
    this.initialized = true;
  }

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null> {
    try {
      await this.ensureInit();
      const worker = await this.aws.acquireGPU({
        minMemory: requirements.minGPUMemory,
        framework: requirements.framework,
        gpuCount: requirements.gpuCount,
      });

      return {
        workerId: worker.workerId,
        gpuId: worker.gpuId,
        ipAddress: worker.ipAddress,
        port: worker.port,
        gpuMemoryGB: worker.memoryGB,
        availableGPUMemory: worker.memoryGB,
        provider: this.name,
        secureRuntimeActive: worker.secureRuntimeActive,
      };
    } catch (error) {
      logger.error(`AWS worker acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async releaseWorker(workerId: string): Promise<void> {
    await this.ensureInit();
    await this.aws.releaseGPU(workerId);
  }

  async healthCheck(_workerId: string): Promise<boolean> {
    try {
      await this.ensureInit();
      return await this.aws.healthCheck();
    } catch {
      return false;
    }
  }

  async getGpuUtilization(workerId: string): Promise<number | null> {
    await this.ensureInit();
    return this.aws.getGpuUtilization(workerId);
  }

  async getPrice(gpuType: string): Promise<number> {
    await this.ensureInit();
    return this.aws.getPrice(gpuType);
  }

  async listAvailable(): Promise<
    Array<{ gpuType: string; memoryGB: number; available: boolean; pricePerHour?: number; id?: string; region?: string }>
  > {
    await this.ensureInit();
    return this.aws.listAvailable();
  }
}

class LambdaLabsGPUProviderAdapter implements GPUProvider {
  name = 'LambdaLabs';
  private lambda: LambdaLabsProvider;
  private initialized = false;

  constructor(lambda?: LambdaLabsProvider) {
    this.lambda = lambda ?? new LambdaLabsProvider();
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.lambda.connect({
      api_key: config.lambda_labs_api_key,
    });
    this.initialized = true;
  }

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null> {
    try {
      await this.ensureInit();
      const worker = await this.lambda.acquireGPU({
        minMemory: requirements.minGPUMemory,
        framework: requirements.framework,
        gpuCount: requirements.gpuCount,
      });

      return {
        workerId: worker.workerId,
        gpuId: worker.gpuId,
        ipAddress: worker.ipAddress,
        port: worker.port,
        gpuMemoryGB: worker.memoryGB,
        availableGPUMemory: worker.memoryGB,
        provider: this.name,
        secureRuntimeActive: worker.secureRuntimeActive,
      };
    } catch (error) {
      logger.error(
        `Lambda Labs worker acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async releaseWorker(workerId: string): Promise<void> {
    await this.ensureInit();
    await this.lambda.releaseGPU(workerId);
  }

  async healthCheck(_workerId: string): Promise<boolean> {
    try {
      await this.ensureInit();
      return await this.lambda.healthCheck();
    } catch {
      return false;
    }
  }

  async getGpuUtilization(workerId: string): Promise<number | null> {
    try {
      await this.ensureInit();
      return await this.lambda.getGpuUtilization(workerId);
    } catch {
      return null;
    }
  }

  async getPrice(gpuType: string): Promise<number> {
    await this.ensureInit();
    return this.lambda.getPrice(gpuType);
  }

  /** Live region prices from Lambda Labs instance-types API. */
  async listAvailable(): Promise<
    Array<{ gpuType: string; memoryGB: number; available: boolean; pricePerHour?: number; id?: string; region?: string }>
  > {
    await this.ensureInit();
    return this.lambda.listAvailable();
  }

  getLambda(): LambdaLabsProvider {
    return this.lambda;
  }
}

function hasAzureCredentials(): boolean {
  return !!(
    config.azure_subscription_id &&
    config.azure_tenant_id &&
    config.azure_client_id &&
    config.azure_client_secret
  );
}

function hasAwsCredentials(): boolean {
  return !!(config.aws_access_key_id && config.aws_secret_access_key);
}

function hasLambdaLabsCredentials(): boolean {
  return !!config.lambda_labs_api_key;
}

/**
 * Ensure REDIS_URL is parseable so createClient does not crash the process.
 * Placeholders like CHANGE_ME_... from docs must not be pasted into Render.
 */
function resolveRedisUrl(raw: string): string {
  const fallback = 'redis://127.0.0.1:6379';
  const url = (raw || '').trim();

  if (!url || /CHANGE_ME|your-redis|placeholder/i.test(url)) {
    logger.warn(
      'REDIS_URL is missing or still a placeholder (do not paste CHANGE_ME_... into Render). ' +
        'Create Render Key Value or Upstash Redis and set redis:// / rediss:// URL. ' +
        `Using ${fallback} so the API can boot — fix REDIS_URL for deploy state / SWR.`,
    );
    return fallback;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      logger.warn(
        `REDIS_URL must start with redis:// or rediss:// (got ${parsed.protocol}). Using ${fallback}`,
      );
      return fallback;
    }
    return url;
  } catch {
    logger.warn(`REDIS_URL is not a valid URL. Using ${fallback}`);
    return fallback;
  }
}

export function createDefaultOrchestrator(redisUrl: string): Orchestrator {
  const safeRedisUrl = resolveRedisUrl(redisUrl);
  const redisClient = createClient({ url: safeRedisUrl });
  logger.info(`Initializing Orchestrator with Redis: ${safeRedisUrl.substring(0, 24)}...`);
  const providers: GPUProvider[] = [];

  if (config.modal_token_id && config.modal_token_secret) {
    const modal = new ModalProvider();
    providers.push(new ModalGPUProviderAdapter(modal));
    logger.info('GPU provider: Modal (real GPU)');
  } else {
    providers.push(new StaticGPUProvider());
    logger.info('GPU provider: Static (mock) — set MODAL_TOKEN_ID/SECRET for real GPU');
  }

  if (hasAzureCredentials()) {
    providers.push(new AzureGPUProviderAdapter());
    logger.info('GPU provider: Azure (service principal configured)');
  }

  if (hasAwsCredentials()) {
    providers.push(new AWSGPUProviderAdapter());
    logger.info('GPU provider: AWS (credentials configured)');
  }

  if (hasLambdaLabsCredentials()) {
    providers.push(new LambdaLabsGPUProviderAdapter());
    logger.info('GPU provider: Lambda Labs (API key configured)');
  }

  const registry = new ProviderRegistry(providers);
  logger.info(`Provider registry: ${registry.list().map((p) => p.name).join(', ')}`);

  return new Orchestrator(providers, redisClient as unknown as RedisClient);
}

export {
  ProviderRegistry,
  AzureGPUProviderAdapter,
  AWSGPUProviderAdapter,
  LambdaLabsGPUProviderAdapter,
};
