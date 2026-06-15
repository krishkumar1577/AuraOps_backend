import { AzureGPUProvider, AZURE_GPU_HOURLY_PRICES } from '../azureGpuProvider';
import { ClientSecretCredential } from '@azure/identity';
import { S3Client } from '@aws-sdk/client-s3';
import type { BlueprintJSON } from '../../../../types/blueprint.types';

jest.mock('@azure/identity');
jest.mock('@azure/arm-compute');
jest.mock('@azure/arm-appservice');
jest.mock('@azure/storage-blob');
jest.mock('@aws-sdk/client-s3');
jest.mock('../../../../utils/config', () => ({
  config: {
    aws_region: 'us-east-1',
    aws_access_key_id: 'test-key',
    aws_secret_access_key: 'test-secret',
    s3_bucket: 'aura-weights',
    aws_endpoint_url: undefined,
  },
}));

function createMockClients() {
  const mockVmSizesList = jest.fn().mockResolvedValue({
    [Symbol.asyncIterator]: async function* () {
      yield { name: 'Standard_NC4as_T4_v3', numberOfCores: 4 };
    },
  });

  const mockBeginCreateOrUpdate = jest.fn().mockResolvedValue({
    pollUntilDone: jest.fn().mockResolvedValue({
      id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1',
      name: 'vm1',
    }),
  });

  const mockBeginDelete = jest.fn().mockResolvedValue(undefined);

  const mockWebAppsCreate = jest.fn().mockResolvedValue({
    pollUntilDone: jest.fn().mockResolvedValue({ defaultHostName: 'auraops-test.azurewebsites.net' }),
  });

  const mockUploadData = jest.fn().mockResolvedValue(undefined);
  const mockGetBlockBlobClient = jest.fn().mockReturnValue({
    uploadData: mockUploadData,
    url: 'https://storage.blob.core.windows.net/aura-weights/test/weights.bin',
  });
  const mockCreateIfNotExists = jest.fn().mockResolvedValue(undefined);
  const mockGetContainerClient = jest.fn().mockReturnValue({
    createIfNotExists: mockCreateIfNotExists,
    getBlockBlobClient: mockGetBlockBlobClient,
  });

  const credential = {} as ClientSecretCredential;

  return {
    compute: {
      virtualMachineSizes: { list: mockVmSizesList },
      virtualMachines: {
        beginCreateOrUpdate: mockBeginCreateOrUpdate,
        beginDelete: mockBeginDelete,
      },
    },
    web: {
      webApps: { beginCreateOrUpdate: mockWebAppsCreate },
    },
    blobs: {
      getContainerClient: mockGetContainerClient,
    },
    credential,
    mockBeginCreateOrUpdate,
    mockWebAppsCreate,
    mockUploadData,
  };
}

describe('AzureGPUProvider', () => {
  const validCredentials = {
    azure_tenant_id: 'tenant-123',
    azure_client_id: 'client-123',
    azure_client_secret: 'secret-123',
    azure_subscription_id: 'sub-123',
    azure_resource_group: 'auraops-rg',
    azure_location: 'eastus',
    azure_storage_account: 'auraopsstorage',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (ClientSecretCredential as jest.Mock).mockImplementation(() => ({}));
  });

  describe('connect', () => {
    it('should connect with valid service principal credentials', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);

      await provider.connect(validCredentials);

      expect(mocks.compute.virtualMachineSizes.list).toHaveBeenCalledWith('eastus');
    });

    it('should throw clear error when tenant id is missing', async () => {
      const provider = new AzureGPUProvider();
      await expect(
        provider.connect({ ...validCredentials, azure_tenant_id: '' }),
      ).rejects.toThrow('AzureGPUProvider connection failed');
    });

    it('should throw clear error on invalid credentials validation failure', async () => {
      const mocks = createMockClients();
      mocks.compute.virtualMachineSizes.list.mockRejectedValue(new Error('Invalid credentials'));
      const provider = new AzureGPUProvider(mocks);

      await expect(provider.connect(validCredentials)).rejects.toThrow(
        'AzureGPUProvider connection failed',
      );
    });
  });

  describe('listAvailable', () => {
    it('should list Azure GPU SKUs with pricing', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      const available = await provider.listAvailable();

      expect(available.length).toBeGreaterThan(0);
      expect(available[0]).toEqual(
        expect.objectContaining({
          gpuType: expect.stringMatching(/T4|A10G|A100|V100/),
          pricePerHour: expect.any(Number),
          region: 'eastus',
        }),
      );
    });
  });

  describe('acquireGPU', () => {
    it('should provision GPU VM successfully', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      const worker = await provider.acquireGPU({ minMemory: 16, framework: 'langgraph' });

      expect(worker.workerId).toBeDefined();
      expect(worker.gpuType).toBe('T4');
      expect(mocks.mockBeginCreateOrUpdate).toHaveBeenCalled();
    });
  });

  describe('getPrice', () => {
    it('should return Azure A10G hourly price for ranking', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      const price = await provider.getPrice('A10G');
      expect(price).toBe(AZURE_GPU_HOURLY_PRICES.A10G);
      expect(price).toBeLessThan(3.5);
    });
  });

  describe('streamWeightFromS3', () => {
    it('should upload weights from S3 to Azure Blob Storage', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      const mockSend = jest.fn().mockResolvedValue({
        Body: {
          transformToByteArray: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
        },
      });
      (S3Client as jest.Mock).mockImplementation(() => ({ send: mockSend }));

      await provider.connect(validCredentials);

      const result = await provider.streamWeightFromS3('models/test/weights.bin', 'dep/weights.bin');

      expect(result.blobUrl).toContain('blob.core.windows.net');
      expect(result.sizeBytes).toBe(4);
      expect(mocks.mockUploadData).toHaveBeenCalled();
    });

    it('should throw when blob storage is not configured', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      (provider as unknown as { blobClient: null }).blobClient = null;

      await expect(
        provider.streamWeightFromS3('models/test.bin', 'test.bin'),
      ).rejects.toThrow('Storage account not configured');
    });
  });

  describe('deployPersistentApp', () => {
    it('should return live HTTPS App Service endpoint URL', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      const blueprint: BlueprintJSON = {
        id: 'bp-1',
        timestamp: new Date().toISOString(),
        framework: {
          framework: 'langgraph',
          version: '0.2.0',
          cudaVersion: '12.1',
          pythonVersion: '3.11',
          primaryUse: 'agentic',
        },
        dependencyLock: {},
        systemRequirements: {
          pythonVersion: '3.11',
          cudaVersion: '12.1',
          cuDNNVersion: '8.9.0',
          baseImageId: 'aura-langchain',
          baseImageTag: 'latest',
          systemPackages: [],
        },
        customModels: [],
        deploymentConfig: {
          entrypoint: 'main.py',
          runtime: 'python',
          memoryMB: 4096,
          gpuRequired: true,
          gpuMemoryGB: 16,
        },
        checksums: { allDepsHash: 'abc', blueprintHash: 'def' },
      };

      const result = await provider.deployPersistentApp('dep-azure-1', blueprint);

      expect(result.endpointUrl).toMatch(/^https:\/\/.+\.azurewebsites\.net$/);
      expect(result.appName).toContain('auraops');
      expect(mocks.mockWebAppsCreate).toHaveBeenCalled();
    });
  });

  describe('releaseGPU', () => {
    it('should throw for unknown worker', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      await expect(provider.releaseGPU('unknown-worker')).rejects.toThrow('Worker not found');
    });
  });

  describe('healthCheck', () => {
    it('should return true when connected', async () => {
      const mocks = createMockClients();
      const provider = new AzureGPUProvider(mocks);
      await provider.connect(validCredentials);

      expect(await provider.healthCheck()).toBe(true);
    });
  });
});
