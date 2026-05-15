import { ModalClient, Sandbox, App } from 'modal';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import type { GPUAcquisitionSpec, GPUInstance, WorkerInstance } from '../../../types/orchestration.types';
import { BaseGPUProvider } from './baseProvider';

const GPU_MEMORY_MAP: Record<string, number> = {
  T4: 16,
  L4: 24,
  A10G: 24,
  A100: 40,
  'A100-80GB': 80,
  H100: 80,
  H200: 141,
  L40S: 48,
};

const GPU_PRICE_MAP: Record<string, number> = {
  T4: 0.59,
  L4: 0.79,
  A10G: 1.10,
  A100: 3.00,
  'A100-80GB': 3.95,
  H100: 4.89,
};

function selectGPU(minMemoryGB: number): string {
  const ranked = Object.entries(GPU_MEMORY_MAP)
    .filter(([, mem]) => mem >= minMemoryGB)
    .sort(([, a], [, b]) => a - b);

  if (ranked.length === 0) {
    throw new DeploymentError(`No GPU available with ${minMemoryGB}GB+ memory`);
  }
  return ranked[0][0];
}

interface ActiveSandbox {
  sandbox: Sandbox;
  sandboxId: string;
  gpuType: string;
  memoryGB: number;
  framework: string;
  createdAt: number;
}

export class ModalProvider extends BaseGPUProvider {
  name = 'Modal';
  private client: ModalClient | null = null;
  private app: App | null = null;
  private activeSandboxes: Map<string, ActiveSandbox> = new Map();

  async validateConnection(): Promise<void> {
    const start = Date.now();
    const tokenId = this.credentials['token_id'];
    const tokenSecret = this.credentials['token_secret'];

    if (!tokenId || !tokenSecret) {
      throw new DeploymentError('Modal: token_id and token_secret credentials required');
    }

    this.client = new ModalClient({ tokenId, tokenSecret });
    this.app = await this.client.apps.fromName('auraops', { createIfMissing: true });
    logger.info(`Modal connection validated in ${Date.now() - start}ms`);
  }

  async listAvailable(): Promise<GPUInstance[]> {
    this.requireConnection();

    return Object.entries(GPU_MEMORY_MAP).map(([gpuType, memoryGB]) => ({
      id: `modal-${gpuType.toLowerCase()}`,
      gpuType,
      memoryGB,
      available: true,
      pricePerHour: GPU_PRICE_MAP[gpuType] ?? 0,
    }));
  }

  async acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance> {
    const start = Date.now();
    this.requireConnection();
    this.validateGPUSpec(spec);

    const gpuType = selectGPU(spec.minMemory);
    const memoryGB = GPU_MEMORY_MAP[gpuType];

    logger.info(`Acquiring Modal sandbox: gpu=${gpuType}, framework=${spec.framework}`);

    try {
      const image = this.client!.images.fromRegistry('python:3.11-slim');
      const workerId = this.generateWorkerId();

      const sandbox = await this.client!.sandboxes.create(this.app!, image, {
        gpu: gpuType,
        timeoutMs: 300_000,
        name: workerId,
      });

      this.activeSandboxes.set(workerId, {
        sandbox,
        sandboxId: sandbox.sandboxId,
        gpuType,
        memoryGB,
        framework: spec.framework,
        createdAt: Date.now(),
      });

      const tunnelInfo = await sandbox.tunnels(30_000).catch(() => ({}));
      const firstTunnel = Object.values(tunnelInfo)[0];

      logger.info(`Modal sandbox acquired in ${Date.now() - start}ms: ${sandbox.sandboxId}`);

      return {
        workerId,
        gpuId: sandbox.sandboxId,
        ipAddress: firstTunnel?.host ?? 'modal-sandbox',
        port: firstTunnel?.port ?? 0,
        gpuType,
        memoryGB,
        framework: spec.framework,
        status: 'ready',
        secureRuntimeActive: false,
      };
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('Modal: GPU acquisition failed', {
        cause: error instanceof Error ? error.message : String(error),
        gpuType,
      });
    }
  }

  async releaseGPU(workerId: string): Promise<void> {
    const start = Date.now();
    this.requireConnection();

    const entry = this.activeSandboxes.get(workerId);
    if (!entry) {
      throw new DeploymentError(`Modal: Worker not found: ${workerId}`);
    }

    try {
      await entry.sandbox.terminate();
      this.activeSandboxes.delete(workerId);
      logger.info(`Modal sandbox released in ${Date.now() - start}ms: ${workerId}`);
    } catch (error) {
      throw new DeploymentError('Modal: GPU release failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getPrice(gpuType: string): Promise<number> {
    return GPU_PRICE_MAP[gpuType] ?? 0;
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.requireConnection();
      return true;
    } catch {
      return false;
    }
  }

  async execInSandbox(workerId: string, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const entry = this.activeSandboxes.get(workerId);
    if (!entry) {
      throw new DeploymentError(`Modal: Worker not found: ${workerId}`);
    }

    const proc = await entry.sandbox.exec(command);
    const stdout = await proc.stdout.readText();
    const stderr = await proc.stderr.readText();
    const exitCode = await proc.wait();

    return { stdout, stderr, exitCode };
  }

  getActiveSandboxCount(): number {
    return this.activeSandboxes.size;
  }

  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}
