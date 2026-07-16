import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { BlobServiceClient, type BlockBlobClient } from '@azure/storage-blob';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { config } from '../../../utils/config';
import type { BlueprintJSON } from '../../../types/blueprint.types';
import type { GPUAcquisitionSpec, GPUInstance, WorkerInstance } from '../../../types/orchestration.types';
import { BaseGPUProvider } from './baseProvider';

const GPU_MEMORY_MAP: Record<string, number> = {
  Standard_NC4as_T4_v3: 16,
  Standard_NC8as_T4_v3: 16,
  Standard_NC16as_T4_v3: 16,
  Standard_NC24rs_v3: 24,
  Standard_NC6s_v3: 16,
  Standard_NC24ads_A100_v4: 80,
};

const GPU_TYPE_MAP: Record<string, string> = {
  Standard_NC4as_T4_v3: 'T4',
  Standard_NC8as_T4_v3: 'T4',
  Standard_NC16as_T4_v3: 'T4',
  Standard_NC24rs_v3: 'A10G',
  Standard_NC6s_v3: 'V100',
  Standard_NC24ads_A100_v4: 'A100',
};

/**
 * USD/hour list prices used for provider ranking (guide map, not live Retail Prices API).
 * Optional overrides: AZURE_PRICE_T4=0.85 or AURAOPS_GPU_PRICE_JSON={"azure":{"T4":0.85}}.
 * Refresh: re-check Azure pricing calculator / Retail Prices API periodically and update map.
 */
export const AZURE_GPU_HOURLY_PRICES: Record<string, number> = {
  T4: 0.90,
  L4: 2.10,
  A10G: 2.50,
  V100: 3.06,
  A100: 3.67,
};

function normalizeAzureGpuType(gpuType: string): string {
  const upper = gpuType.trim().toUpperCase().replace(/_/g, '-');
  if (upper === 'A10') return 'A10G';
  const known = Object.keys(AZURE_GPU_HOURLY_PRICES).find((k) => k.toUpperCase() === upper);
  return known ?? gpuType.trim();
}

function loadAzurePriceOverrides(): Record<string, number> {
  const overrides: Record<string, number> = {};

  const jsonRaw = process.env.AURAOPS_GPU_PRICE_JSON;
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
      const azureSection = parsed.azure ?? parsed.Azure;
      if (azureSection && typeof azureSection === 'object' && !Array.isArray(azureSection)) {
        for (const [key, value] of Object.entries(azureSection as Record<string, unknown>)) {
          if (typeof value === 'number' && value > 0) {
            overrides[normalizeAzureGpuType(key)] = value;
          } else if (typeof value === 'string') {
            const n = parseFloat(value);
            if (!Number.isNaN(n) && n > 0) overrides[normalizeAzureGpuType(key)] = n;
          }
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }

  for (const key of Object.keys(AZURE_GPU_HOURLY_PRICES)) {
    const envKey = `AZURE_PRICE_${key.replace(/-/g, '_').toUpperCase()}`;
    const raw = process.env[envKey];
    if (raw) {
      const n = parseFloat(raw);
      if (!Number.isNaN(n) && n > 0) overrides[key] = n;
    }
  }

  return overrides;
}

function resolveAzurePrice(gpuType: string): number {
  const normalized = normalizeAzureGpuType(gpuType);
  const overrides = loadAzurePriceOverrides();
  return overrides[normalized] ?? AZURE_GPU_HOURLY_PRICES[normalized] ?? 2.5;
}

export interface AzureComputeClient {
  virtualMachineSizes: {
    list(location: string): Promise<unknown>;
  };
  virtualMachines: {
    beginCreateOrUpdate(
      resourceGroup: string,
      name: string,
      parameters: unknown,
    ): Promise<{ pollUntilDone(): Promise<{ id?: string; name?: string }> }>;
    beginDelete(resourceGroup: string, name: string): Promise<unknown>;
  };
}

export interface AzureWebClient {
  webApps: {
    beginCreateOrUpdate(
      resourceGroup: string,
      name: string,
      parameters: unknown,
    ): Promise<{ pollUntilDone(): Promise<{ defaultHostName?: string }> }>;
  };
}

export interface AzureBlobClient {
  getContainerClient(name: string): {
    createIfNotExists(): Promise<unknown>;
    getBlockBlobClient(blobName: string): {
      uploadData(data: Uint8Array): Promise<unknown>;
      url: string;
    };
  };
}

export interface AzureClientBundle {
  compute: AzureComputeClient;
  web: AzureWebClient;
  blobs: AzureBlobClient;
  credential: ClientSecretCredential;
}

export class AzureGPUProvider extends BaseGPUProvider {
  name = 'AzureGPUProvider';
  private computeClient: ComputeManagementClient | null = null;
  private webClient: WebSiteManagementClient | null = null;
  private blobClient: BlobServiceClient | null = null;
  private s3Client: S3Client | null = null;
  private credential: ClientSecretCredential | null = null;
  private subscriptionId = '';
  private resourceGroup = '';
  private location = 'eastus';
  private storageAccount = '';
  private storageContainer = 'aura-weights';
  private activeWorkers: Map<string, string> = new Map();
  private deployedApps: Map<string, { endpointUrl: string; appName: string }> = new Map();
  private readonly clientBundle?: AzureClientBundle;

  constructor(clientBundle?: AzureClientBundle) {
    super();
    this.clientBundle = clientBundle;
  }

  async validateConnection(): Promise<void> {
    const start = Date.now();
    const tenantId = this.credentials['azure_tenant_id'];
    const clientId = this.credentials['azure_client_id'];
    const clientSecret = this.credentials['azure_client_secret'];
    this.subscriptionId = this.credentials['azure_subscription_id'] || '';
    this.resourceGroup = this.credentials['azure_resource_group'] || 'auraops-rg';
    this.location = this.credentials['azure_location'] || 'eastus';
    this.storageAccount = this.credentials['azure_storage_account'] || '';

    if (!tenantId || !clientId || !clientSecret || !this.subscriptionId) {
      throw new DeploymentError(
        'Azure: azure_tenant_id, azure_client_id, azure_client_secret, and azure_subscription_id required',
      );
    }

    try {
      if (this.clientBundle) {
        this.credential = this.clientBundle.credential;
        this.computeClient = this.clientBundle.compute as unknown as ComputeManagementClient;
        this.webClient = this.clientBundle.web as unknown as WebSiteManagementClient;
        this.blobClient = this.clientBundle.blobs as unknown as BlobServiceClient;
      } else {
        this.credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
        this.computeClient = new ComputeManagementClient(this.credential, this.subscriptionId);
        this.webClient = new WebSiteManagementClient(this.credential, this.subscriptionId);

        if (this.storageAccount) {
          const blobUrl = `https://${this.storageAccount}.blob.core.windows.net`;
          this.blobClient = new BlobServiceClient(blobUrl, this.credential);
        }
      }

      if (config.aws_access_key_id && config.aws_secret_access_key) {
        this.s3Client = new S3Client({
          region: config.aws_region,
          credentials: {
            accessKeyId: config.aws_access_key_id,
            secretAccessKey: config.aws_secret_access_key,
          },
          ...(config.aws_endpoint_url ? { endpoint: config.aws_endpoint_url } : {}),
        });
      }

      await this.computeClient!.virtualMachineSizes.list(this.location);
      logger.debug(`Azure connection validated in ${Date.now() - start}ms`);
    } catch (error) {
      throw new DeploymentError('Azure: Failed to validate service principal credentials', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listAvailable(): Promise<GPUInstance[]> {
    const start = Date.now();
    this.requireConnection();

    try {
      const available: GPUInstance[] = [];

      for (const [sku, memoryGB] of Object.entries(GPU_MEMORY_MAP)) {
        const gpuType = GPU_TYPE_MAP[sku];
        available.push({
          id: sku,
          gpuType,
          memoryGB,
          available: true,
          region: this.location,
          pricePerHour: resolveAzurePrice(gpuType),
        });
      }

      logger.info(`✓ Listed ${available.length} Azure GPU SKUs in ${Date.now() - start}ms`);
      return available;
    } catch (error) {
      throw new DeploymentError('Azure: Failed to list GPU SKUs', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance> {
    const start = Date.now();
    this.requireConnection();
    this.validateGPUSpec(spec);

    try {
      const matching = this.findMatchingSku(spec.minMemory);
      if (!matching) {
        throw new DeploymentError(
          `Azure: No GPU SKU available with minimum ${spec.minMemory}GB memory`,
        );
      }

      const vmName = `auraops-worker-${Date.now()}`;
      logger.info(`Provisioning Azure GPU VM: ${matching.sku}`);

      const poller = await this.computeClient!.virtualMachines.beginCreateOrUpdate(
        this.resourceGroup,
        vmName,
        {
          location: this.location,
          hardwareProfile: { vmSize: matching.sku },
          storageProfile: {
            imageReference: {
              publisher: 'microsoft-dsvm',
              offer: 'ubuntu-hpc',
              sku: '2204',
              version: 'latest',
            },
          },
          osProfile: {
            computerName: vmName,
            adminUsername: 'azureuser',
            adminPassword: `AuraOps${Date.now().toString(36)}!`,
          },
          networkProfile: {
            networkInterfaces: [],
          },
          tags: {
            framework: spec.framework,
            managedBy: 'auraops',
          },
        },
      );

      const vm = await poller.pollUntilDone();
      const workerId = this.generateWorkerId();
      this.activeWorkers.set(workerId, vm.id || vmName);

      logger.info(`✓ Azure GPU acquired in ${Date.now() - start}ms: ${vmName}`);

      return {
        workerId,
        gpuId: vm.id || vmName,
        ipAddress: 'pending',
        port: 443,
        gpuType: GPU_TYPE_MAP[matching.sku],
        memoryGB: matching.memoryGB,
        framework: spec.framework,
        status: 'ready',
        secureRuntimeActive: false,
      };
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('Azure: GPU acquisition failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async releaseGPU(workerId: string): Promise<void> {
    const start = Date.now();
    this.requireConnection();

    try {
      const vmId = this.activeWorkers.get(workerId);
      if (!vmId) {
        throw new DeploymentError(`Azure: Worker not found: ${workerId}`);
      }

      const vmName = vmId.split('/').pop() || vmId;
      await this.computeClient!.virtualMachines.beginDelete(this.resourceGroup, vmName);
      this.activeWorkers.delete(workerId);
      logger.info(`✓ Azure GPU released in ${Date.now() - start}ms: ${workerId}`);
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('Azure: GPU release failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getPrice(gpuType: string, _region?: string): Promise<number> {
    this.requireConnection();
    return resolveAzurePrice(gpuType);
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.requireConnection();
      await this.computeClient!.virtualMachineSizes.list(this.location);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stream model weights from S3 into Azure Blob Storage.
   */
  async streamWeightFromS3(s3Key: string, blobName: string): Promise<{ blobUrl: string; sizeBytes: number }> {
    const start = Date.now();
    this.requireConnection();

    if (!this.blobClient) {
      throw new DeploymentError('Azure: Storage account not configured for weight streaming');
    }
    if (!this.s3Client) {
      throw new DeploymentError('Azure: AWS S3 credentials required for weight streaming');
    }

    try {
      const s3Response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: config.s3_bucket,
          Key: s3Key,
        }),
      );

      const body = s3Response.Body;
      if (!body) {
        throw new DeploymentError(`Azure: S3 object empty: ${s3Key}`);
      }

      const bytes = await body.transformToByteArray();
      const container = this.blobClient.getContainerClient(this.storageContainer);
      await container.createIfNotExists();
      const blob: BlockBlobClient = container.getBlockBlobClient(blobName);
      await blob.uploadData(bytes);

      const blobUrl = blob.url;
      logger.info(
        `✓ Streamed weight S3→Azure (${(bytes.length / 1024 / 1024).toFixed(2)}MB) in ${Date.now() - start}ms`,
      );

      return { blobUrl, sizeBytes: bytes.length };
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('Azure: Weight streaming failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Deploy persistent HTTPS endpoint via Azure App Service on GPU-backed plan.
   */
  async deployPersistentApp(
    deploymentId: string,
    blueprint: BlueprintJSON,
    deployConfig?: { skipPipInstall?: boolean; cachedImageRef?: string; gpuCount?: number; enableMcp?: boolean },
  ): Promise<{ endpointUrl: string; appName: string; imageRef: string }> {
    const start = Date.now();
    this.requireConnection();

    if (!blueprint.framework?.framework) {
      throw new DeploymentError('Azure: Invalid blueprint — missing framework', { deploymentId });
    }

    const appName = `auraops-${deploymentId.replace(/-/g, '').slice(0, 12)}`;
    const endpointUrl = `https://${appName}.azurewebsites.net`;

    try {
      for (const model of blueprint.customModels ?? []) {
        if (model.path && model.hash) {
          const s3Key = model.path.startsWith('s3://')
            ? model.path.replace(/^s3:\/\/[^/]+\//, '')
            : model.path;
          await this.streamWeightFromS3(s3Key, `${deploymentId}/${model.hash}/weights.bin`);
        }
      }

      await this.webClient!.webApps.beginCreateOrUpdate(
        this.resourceGroup,
        appName,
        {
          location: this.location,
          kind: 'app,linux,container',
          sku: { name: 'P1v3', tier: 'PremiumV3' },
          siteConfig: {
            linuxFxVersion: `DOCKER|${blueprint.systemRequirements.baseImageId}:${blueprint.systemRequirements.baseImageTag}`,
            alwaysOn: true,
            appSettings: [
              { name: 'FRAMEWORK', value: blueprint.framework.framework },
              { name: 'GPU_MEMORY_GB', value: String(blueprint.deploymentConfig?.gpuMemoryGB ?? 16) },
              { name: 'GPU_COUNT', value: String(deployConfig?.gpuCount ?? 1) },
              { name: 'WEBSITES_PORT', value: '8000' },
            ],
          },
          tags: {
            deploymentId,
            framework: blueprint.framework.framework,
            managedBy: 'auraops',
          },
        } as unknown as import('@azure/arm-appservice').Site,
      );

      this.deployedApps.set(deploymentId, { endpointUrl, appName });
      const imageRef = deployConfig?.cachedImageRef || `${blueprint.systemRequirements.baseImageId}:${blueprint.systemRequirements.baseImageTag}`;

      logger.info(`✓ Azure App Service deployed in ${Date.now() - start}ms: ${endpointUrl}`);

      return { endpointUrl, appName, imageRef };
    } catch (error) {
      throw new DeploymentError('Azure: Persistent deployment failed', {
        deploymentId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getDeployedEndpoint(deploymentId: string): string | undefined {
    return this.deployedApps.get(deploymentId)?.endpointUrl;
  }

  private findMatchingSku(minMemory: number): { sku: string; memoryGB: number } | null {
    const matching = Object.entries(GPU_MEMORY_MAP)
      .filter(([, memory]) => memory >= minMemory)
      .sort((a, b) => a[1] - b[1])[0];

    if (!matching) return null;
    return { sku: matching[0], memoryGB: matching[1] };
  }
}

export default AzureGPUProvider;
