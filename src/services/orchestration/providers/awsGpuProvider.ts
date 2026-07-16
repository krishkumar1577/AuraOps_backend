import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  Instance as EC2Instance,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import type { GPUAcquisitionSpec, GPUInstance, WorkerInstance } from '../../../types/orchestration.types';
import { BaseGPUProvider } from './baseProvider';

const GPU_MEMORY_MAP: Record<string, number> = {
  'g4dn.xlarge': 16,
  'g4dn.2xlarge': 32,
  'g4dn.12xlarge': 192,
  'p3.2xlarge': 64,
  'p3.8xlarge': 256,
  'p3.16xlarge': 512,
  'p4d.24xlarge': 320,
};

const GPU_TYPE_MAP: Record<string, string> = {
  'g4dn.xlarge': 'T4',
  'g4dn.2xlarge': 'T4',
  'g4dn.12xlarge': 'T4',
  'p3.2xlarge': 'V100',
  'p3.8xlarge': 'V100',
  'p3.16xlarge': 'V100',
  'p4d.24xlarge': 'A100',
};

export class AWSGPUProvider extends BaseGPUProvider {
  name = 'AWSGPUProvider';
  private ec2Client: EC2Client | null = null;
  private pricingClient: PricingClient | null = null;
  private activeInstances: Map<string, string> = new Map();
  private priceCache: Map<string, number> = new Map();
  private ami: string = '';
  private securityGroupId: string = '';

  async validateConnection(): Promise<void> {
    const start = Date.now();
    const accessKeyId = this.credentials['aws_access_key_id'];
    const secretAccessKey = this.credentials['aws_secret_access_key'];
    this.ami = this.credentials['ami'] || 'ami-0c55b159cbfafe1f0';
    this.securityGroupId = this.credentials['security_group_id'] || 'default';

    if (!accessKeyId || !secretAccessKey) {
      throw new DeploymentError('AWS: aws_access_key_id and aws_secret_access_key required');
    }

    try {
      this.ec2Client = new EC2Client({
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
        region: this.credentials['region'] || 'us-east-1',
      });

      this.pricingClient = new PricingClient({
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
        region: 'us-east-1',
      });

      await this.ec2Client.send(new DescribeInstancesCommand({}));
      logger.debug(`AWS connection validated in ${Date.now() - start}ms`);
    } catch (error) {
      throw new DeploymentError('AWS: Failed to validate credentials', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listAvailable(): Promise<GPUInstance[]> {
    const start = Date.now();
    this.requireConnection();

    try {
      const available: GPUInstance[] = [];

      for (const instanceType of Object.keys(GPU_MEMORY_MAP)) {
        available.push({
          id: instanceType,
          gpuType: GPU_TYPE_MAP[instanceType],
          memoryGB: GPU_MEMORY_MAP[instanceType],
          available: true,
          region: this.ec2Client!.config.region as string,
          pricePerHour: this.priceCache.get(instanceType),
        });
      }

      logger.info(`✓ Listed ${available.length} GPU instance types from AWS in ${Date.now() - start}ms`);
      return available;
    } catch (error) {
      throw new DeploymentError('AWS: Failed to list instances', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance> {
    const start = Date.now();
    this.requireConnection();
    this.validateGPUSpec(spec);

    try {
      const matching = this.findMatchingInstanceType(spec.minMemory);
      if (!matching) {
        throw new DeploymentError(
          `AWS: No GPU instance type available with minimum ${spec.minMemory}GB memory`,
        );
      }

      logger.info(`Acquiring AWS GPU: ${matching.instanceType}`);

      const launchResponse = await this.ec2Client!.send(
        new RunInstancesCommand({
          ImageId: this.ami,
          InstanceType: matching.instanceType as _InstanceType,
          MinCount: 1,
          MaxCount: 1,
          SecurityGroupIds: [this.securityGroupId],
          TagSpecifications: [
            {
              ResourceType: 'instance',
              Tags: [
                { Key: 'Name', Value: `auraops-worker-${Date.now()}` },
                { Key: 'framework', Value: spec.framework },
              ],
            },
          ],
        }),
      );

      if (!launchResponse.Instances || launchResponse.Instances.length === 0) {
        throw new DeploymentError('AWS: Launch response missing instance data');
      }

      const instance = launchResponse.Instances[0];
      const instanceId = instance.InstanceId!;

      await this.waitForRunning(instanceId, spec.maxWaitSeconds || 60);
      const runningInstance = await this.getInstanceDetails(instanceId);

      const workerId = this.generateWorkerId();
      this.activeInstances.set(workerId, instanceId);

      logger.info(`✓ GPU acquired in ${Date.now() - start}ms: ${runningInstance.PrivateIpAddress}`);

      return {
        workerId,
        gpuId: instanceId,
        ipAddress: runningInstance.PrivateIpAddress || 'pending',
        port: 22,
        gpuType: GPU_TYPE_MAP[matching.instanceType],
        memoryGB: matching.memoryGB,
        framework: spec.framework,
        status: 'ready',
        secureRuntimeActive: false,
      };
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('AWS: GPU acquisition failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async releaseGPU(workerId: string): Promise<void> {
    const start = Date.now();
    this.requireConnection();

    try {
      const instanceId = this.activeInstances.get(workerId);
      if (!instanceId) {
        throw new DeploymentError(`AWS: Worker not found: ${workerId}`);
      }

      await this.ec2Client!.send(
        new TerminateInstancesCommand({
          InstanceIds: [instanceId],
        }),
      );

      this.activeInstances.delete(workerId);
      logger.info(`✓ GPU released in ${Date.now() - start}ms: ${workerId}`);
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('AWS: GPU release failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getPrice(gpuType: string, region?: string): Promise<number> {
    this.requireConnection();

    try {
      const cached = this.priceCache.get(gpuType);
      if (cached !== undefined) {
        return cached;
      }

      const pricingResponse = await this.pricingClient!.send(
        new GetProductsCommand({
          ServiceCode: 'AmazonEC2',
          Filters: [
            { Type: 'TERM_MATCH', Field: 'instanceType', Value: gpuType },
            { Type: 'TERM_MATCH', Field: 'location', Value: region || 'US East (N. Virginia)' },
          ],
          MaxResults: 1,
        }),
      );

      if (!pricingResponse.PriceList || pricingResponse.PriceList.length === 0) {
        logger.warn(`No pricing found for ${gpuType}`);
        return 0;
      }

      const priceData = JSON.parse(pricingResponse.PriceList[0]) as {
        terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, { pricePerUnit?: { USD?: string } }> }> };
      };
      const terms = Object.values(priceData.terms?.OnDemand || {})[0];
      if (!terms) {
        return 0;
      }

      const priceDimensions = Object.values(terms.priceDimensions || {})[0];
      const price = parseFloat(priceDimensions?.pricePerUnit?.USD || '0');

      this.priceCache.set(gpuType, price);
      return price;
    } catch (error) {
      logger.warn(`Failed to get price for ${gpuType}`, { error });
      return 0;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.requireConnection();
      await this.ec2Client!.send(new DescribeInstancesCommand({}));
      return true;
    } catch {
      return false;
    }
  }

  async getGpuUtilization(_workerId: string): Promise<number | null> {
    return null;
  }

  private async getInstanceDetails(instanceId: string): Promise<EC2Instance> {
    const response = await this.ec2Client!.send(
      new DescribeInstancesCommand({
        InstanceIds: [instanceId],
      }),
    );

    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      throw new DeploymentError(`AWS: Instance not found: ${instanceId}`);
    }
    return instance;
  }

  private async waitForRunning(instanceId: string, maxWaitSeconds: number): Promise<void> {
    const maxAttempts = Math.min(maxWaitSeconds * 2, 120);
    let attempts = 0;

    while (attempts < maxAttempts) {
      const instance = await this.getInstanceDetails(instanceId);
      if (instance.State?.Name === 'running') {
        logger.debug(`AWS instance ${instanceId} running after ${attempts * 0.5}s`);
        return;
      }

      await this.sleep(500);
      attempts++;
    }

    throw new DeploymentError(`AWS: Instance provisioning timeout (${maxWaitSeconds}s)`);
  }

  private findMatchingInstanceType(minMemory: number): { instanceType: string; memoryGB: number } | null {
    const matching = Object.entries(GPU_MEMORY_MAP)
      .filter(([_, memory]) => memory >= minMemory)
      .sort((a, b) => a[1] - b[1])[0];

    if (!matching) {
      return null;
    }

    return {
      instanceType: matching[0],
      memoryGB: matching[1],
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }
}
