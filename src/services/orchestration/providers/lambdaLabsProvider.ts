import axios, { AxiosInstance } from 'axios';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import type { GPUAcquisitionSpec, GPUInstance, WorkerInstance } from '../../../types/orchestration.types';
import { BaseGPUProvider } from './baseProvider';

interface LambdaLabsInstance {
  id: string;
  instance_type: {
    name: string;
    gpu_count: number;
    gpu_memory_gb: number;
    description: string;
  };
  status: string;
  ip: string;
  ssh_port: number;
  region_name: string;
  price_cents_per_hour: number;
}

interface LambdaLabsInstanceType {
  name: string;
  gpu_count: number;
  gpu_memory_gb: number;
  description: string;
  regions_with_capacity_available: Array<{
    region_name: string;
    cost_cents_per_hour: number;
  }>;
}

export class LambdaLabsProvider extends BaseGPUProvider {
  name = 'LambdaLabs';
  private client: AxiosInstance | null = null;
  private apiKey: string = '';
  private activeInstances: Map<string, LambdaLabsInstance> = new Map();

  async validateConnection(): Promise<void> {
    const start = Date.now();
    this.apiKey = this.credentials['api_key'];
    if (!this.apiKey) {
      throw new DeploymentError('LambdaLabs: api_key credential required');
    }

    this.client = axios.create({
      baseURL: 'https://api.lambdalabs.com/v1',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`,
      },
      timeout: 10000,
    });

    try {
      await this.client.get('/instance-types');
      logger.debug(`LambdaLabs connection validated in ${Date.now() - start}ms`);
    } catch (error) {
      throw new DeploymentError('LambdaLabs: Failed to validate API key', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listAvailable(): Promise<GPUInstance[]> {
    const start = Date.now();
    this.requireConnection();

    try {
      const response = await this.client!.get('/instance-types');
      const instanceTypes = response.data.data as Record<string, LambdaLabsInstanceType>;

      const available: GPUInstance[] = [];
      for (const [typeId, instanceType] of Object.entries(instanceTypes)) {
        for (const region of instanceType.regions_with_capacity_available) {
          available.push({
            id: `${typeId}:${region.region_name}`,
            gpuType: instanceType.name,
            memoryGB: instanceType.gpu_memory_gb * instanceType.gpu_count,
            available: true,
            region: region.region_name,
            pricePerHour: region.cost_cents_per_hour / 100,
          });
        }
      }

      logger.info(`✓ Listed ${available.length} GPU instances from LambdaLabs in ${Date.now() - start}ms`);
      return available;
    } catch (error) {
      throw new DeploymentError('LambdaLabs: Failed to list instances', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance> {
    const start = Date.now();
    this.requireConnection();
    this.validateGPUSpec(spec);

    try {
      const available = await this.listAvailable();
      const matching = available.find(
        (gpu) => gpu.memoryGB >= spec.minMemory && (!spec.region || gpu.region === spec.region),
      );

      if (!matching) {
        throw new DeploymentError(
          `LambdaLabs: No GPU available matching spec (minMemory: ${spec.minMemory}GB)`,
        );
      }

      const [typeId, region] = matching.id.split(':');
      logger.info(`Acquiring LambdaLabs GPU: ${matching.gpuType} in ${region}`);

      const launchResponse = await this.client!.post('/instance-operations/launch', {
        instance_type_name: typeId,
        region_name: region,
        quantity: 1,
      });

      if (!launchResponse.data.data || launchResponse.data.data.length === 0) {
        throw new DeploymentError('LambdaLabs: Launch response missing instance data');
      }

      const instanceId = launchResponse.data.data[0];
      await this.waitForReady(instanceId, spec.maxWaitSeconds || 30);

      const instance = await this.getInstance(instanceId);
      const workerId = this.generateWorkerId();
      this.activeInstances.set(workerId, instance);

      logger.info(`✓ GPU acquired in ${Date.now() - start}ms: ${instance.ip}:${instance.ssh_port}`);

      return {
        workerId,
        gpuId: instanceId,
        ipAddress: instance.ip,
        port: instance.ssh_port,
        gpuType: instance.instance_type.name,
        memoryGB: instance.instance_type.gpu_memory_gb,
        framework: spec.framework,
        status: 'ready',
      };
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('LambdaLabs: GPU acquisition failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async releaseGPU(workerId: string): Promise<void> {
    const start = Date.now();
    this.requireConnection();

    try {
      const instance = this.activeInstances.get(workerId);
      if (!instance) {
        throw new DeploymentError(`LambdaLabs: Worker not found: ${workerId}`);
      }

      await this.client!.post('/instance-operations/terminate', {
        instance_ids: [instance.id],
      });

      this.activeInstances.delete(workerId);
      logger.info(`✓ GPU released in ${Date.now() - start}ms: ${workerId}`);
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('LambdaLabs: GPU release failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getPrice(gpuType: string, region?: string): Promise<number> {
    this.requireConnection();

    try {
      const available = await this.listAvailable();
      const matching = available.find((gpu) => gpu.gpuType === gpuType && (!region || gpu.region === region));

      if (!matching || !matching.pricePerHour) {
        return 0;
      }

      return matching.pricePerHour;
    } catch (error) {
      logger.warn(`Failed to get price for ${gpuType}`, { error });
      return 0;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.requireConnection();
      const response = await this.client!.get('/instance-types', { timeout: 5000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private async getInstance(instanceId: string): Promise<LambdaLabsInstance> {
    const response = await this.client!.get(`/instances/${instanceId}`);
    return response.data.data as LambdaLabsInstance;
  }

  private async waitForReady(instanceId: string, maxWaitSeconds: number): Promise<void> {
    const maxAttempts = Math.min(maxWaitSeconds * 2, 60);
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const instance = await this.getInstance(instanceId);
        if (instance.status === 'active') {
          logger.debug(`LambdaLabs instance ${instanceId} ready after ${attempts * 0.5}s`);
          return;
        }
      } catch {
        // Instance may not exist yet, retry
      }

      await this.sleep(500);
      attempts++;
    }

    throw new DeploymentError(`LambdaLabs: Instance provisioning timeout (${maxWaitSeconds}s)`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
