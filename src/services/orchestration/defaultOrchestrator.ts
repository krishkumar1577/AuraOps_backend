import { createClient } from 'redis';
import { Orchestrator, GPUProvider, WorkerInfo, WorkerRequirements, RedisClient } from './orchestrator';
import { ModalProvider } from './providers/modalProvider';
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

  async deployPersistentApp(deploymentId: string, blueprint: any): Promise<{ endpointUrl: string; appName: string }> {
    return await this.modal.deployPersistentApp(deploymentId, blueprint);
  }

  async stopPersistentApp(deploymentId: string): Promise<void> {
    return await this.modal.stopPersistentApp(deploymentId);
  }

  getModal(): ModalProvider {
    return this.modal;
  }
}

export function createDefaultOrchestrator(redisUrl: string): Orchestrator {
  const redisClient = createClient({ url: redisUrl });
  logger.info(`Initializing Orchestrator with Redis: ${redisUrl.substring(0, 15)}...`);
  const providers: GPUProvider[] = [];

  if (config.modal_token_id && config.modal_token_secret) {
    const modal = new ModalProvider();
    providers.push(new ModalGPUProviderAdapter(modal));
    logger.info('GPU provider: Modal (real GPU)');
  } else {
    providers.push(new StaticGPUProvider());
    logger.info('GPU provider: Static (mock) — set MODAL_TOKEN_ID/SECRET for real GPU');
  }

  return new Orchestrator(providers, redisClient as unknown as RedisClient);
}
