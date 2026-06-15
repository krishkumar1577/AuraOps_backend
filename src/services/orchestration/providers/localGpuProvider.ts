import { execSync } from 'child_process';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import type { GPUAcquisitionSpec, GPUInstance, WorkerInstance } from '../../../types/orchestration.types';
import { BaseGPUProvider } from './baseProvider';

interface LocalGPU {
  id: number;
  name: string;
  memoryMB: number;
  available: boolean;
}

export class LocalGPUProvider extends BaseGPUProvider {
  name = 'LocalGPUProvider';
  private localGPUs: Map<number, LocalGPU> = new Map();
  private reservations: Map<string, number> = new Map();
  private isGVisorAvailable: boolean = false;

  async validateConnection(): Promise<void> {
    const start = Date.now();

    try {
      const output = execSync('nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.parseNvidiaSmiOutput(output);
      this.checkGVisorAvailability();

      if (this.localGPUs.size === 0) {
        throw new DeploymentError('LocalGPUProvider: No GPU detected via nvidia-smi');
      }

      logger.info(
        `✓ LocalGPUProvider initialized with ${this.localGPUs.size} GPU(s) (gVisor: ${this.isGVisorAvailable}) in ${Date.now() - start}ms`,
      );
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('LocalGPUProvider: nvidia-smi not available or failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private checkGVisorAvailability(): void {
    try {
      execSync('runsc --version', { stdio: 'ignore' });
      this.isGVisorAvailable = true;
    } catch {
      this.isGVisorAvailable = false;
    }
  }

  async listAvailable(): Promise<GPUInstance[]> {
    const start = Date.now();
    this.requireConnection();

    const available: GPUInstance[] = [];
    for (const gpu of this.localGPUs.values()) {
      available.push({
        id: `local-gpu-${gpu.id}`,
        gpuType: gpu.name,
        memoryGB: Math.round(gpu.memoryMB / 1024),
        available: gpu.available,
        region: 'local',
        pricePerHour: 0,
      });
    }

    logger.info(`✓ Listed ${available.length} local GPU(s) in ${Date.now() - start}ms`);
    return available;
  }

  async acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance> {
    const start = Date.now();
    this.requireConnection();
    this.validateGPUSpec(spec);

    if (spec.secureRuntime && !this.isGVisorAvailable) {
      throw new DeploymentError('LocalGPUProvider: gVisor (runsc) runtime requested but not available on this host');
    }

    try {
      const matching = Array.from(this.localGPUs.values()).find(
        (gpu) => gpu.available && (gpu.memoryMB / 1024) >= spec.minMemory,
      );

      if (!matching) {
        throw new DeploymentError(
          `LocalGPUProvider: No available GPU with minimum ${spec.minMemory}GB memory`,
        );
      }

      matching.available = false;
      const workerId = this.generateWorkerId();
      this.reservations.set(workerId, matching.id);

      logger.info(`✓ Local GPU ${matching.id} acquired in ${Date.now() - start}ms (Secure: ${spec.secureRuntime || false})`);

      return {
        workerId,
        gpuId: `gpu-${matching.id}`,
        ipAddress: 'localhost',
        port: 6006,
        gpuType: matching.name,
        memoryGB: Math.round(matching.memoryMB / 1024),
        framework: spec.framework,
        status: 'ready',
        secureRuntimeActive: spec.secureRuntime && this.isGVisorAvailable ? true : false,
      };
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('LocalGPUProvider: GPU acquisition failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async releaseGPU(workerId: string): Promise<void> {
    const start = Date.now();
    this.requireConnection();

    try {
      const gpuId = this.reservations.get(workerId);
      if (gpuId === undefined) {
        throw new DeploymentError(`LocalGPUProvider: Worker not found: ${workerId}`);
      }

      const gpu = this.localGPUs.get(gpuId);
      if (gpu) {
        gpu.available = true;
      }

      this.reservations.delete(workerId);
      logger.info(`✓ Local GPU released in ${Date.now() - start}ms: ${workerId}`);
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('LocalGPUProvider: GPU release failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getPrice(_gpuType: string, _region?: string): Promise<number> {
    this.requireConnection();
    return 0;
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.requireConnection();
      execSync('nvidia-smi --query-gpu=index --format=csv,noheader', {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  async getGpuUtilization(_workerId: string): Promise<number | null> {
    return null;
  }

  private parseNvidiaSmiOutput(output: string): void {
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const [indexStr, name, memoryStr] = line.split(',').map((s) => s.trim());
      const index = parseInt(indexStr, 10);
      const memoryMB = parseInt(memoryStr.replace(/\s*MB$/, ''), 10);

      if (!isNaN(index) && !isNaN(memoryMB)) {
        this.localGPUs.set(index, {
          id: index,
          name: name || 'Unknown GPU',
          memoryMB,
          available: true,
        });
      }
    }
  }
}
