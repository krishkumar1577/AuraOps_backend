import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import type { GPUAcquisitionSpec, GPUInstance, GPUProvider, WorkerInstance } from '../../../types/orchestration.types';

export abstract class BaseGPUProvider implements GPUProvider {
  abstract name: string;
  protected credentials: Record<string, string> = {};
  protected connected: boolean = false;

  async connect(credentials: Record<string, string>): Promise<void> {
    const start = Date.now();
    try {
      if (!credentials || Object.keys(credentials).length === 0) {
        throw new DeploymentError(`${this.name}: Missing required credentials`);
      }
      this.credentials = credentials;
      await this.validateConnection();
      this.connected = true;
      logger.info(`✓ ${this.name} connected in ${Date.now() - start}ms`);
    } catch (error) {
      throw new DeploymentError(`${this.name} connection failed`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected requireConnection(): void {
    if (!this.connected) {
      throw new DeploymentError(`${this.name}: Not connected. Call connect() first`);
    }
  }

  abstract validateConnection(): Promise<void>;
  abstract listAvailable(): Promise<GPUInstance[]>;
  abstract acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance>;
  abstract releaseGPU(workerId: string): Promise<void>;
  abstract getPrice(gpuType: string, region?: string): Promise<number>;
  abstract healthCheck(): Promise<boolean>;

  protected generateWorkerId(): string {
    return `worker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  protected validateGPUSpec(spec: GPUAcquisitionSpec): void {
    if (spec.minMemory <= 0) {
      throw new DeploymentError('GPU spec: minMemory must be greater than 0');
    }
    if (!spec.framework || spec.framework.trim().length === 0) {
      throw new DeploymentError('GPU spec: framework is required');
    }
    if (spec.maxWaitSeconds && spec.maxWaitSeconds <= 0) {
      throw new DeploymentError('GPU spec: maxWaitSeconds must be positive');
    }
  }
}
