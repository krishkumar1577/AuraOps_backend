import { deploymentRoutes } from '../deployment.routes';
import { Orchestrator, DeploymentStatus, WorkerInfo } from '../../../services/orchestration';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

// Mock dependencies
jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../services/swr/redisClient', () => ({
  RedisWeightRegistry: jest.fn().mockImplementation(() => ({
    getWeightCache: jest.fn().mockResolvedValue(null),
    setWeightCache: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../services/swr/imageLayerCache', () => ({
  ImageLayerCache: jest.fn().mockImplementation(() => ({
    lookup: jest.fn().mockResolvedValue(null),
    register: jest.fn().mockResolvedValue(undefined),
    computeLayerKey: jest.fn().mockReturnValue('abc123'),
  })),
}));

jest.mock('../../../services/telemetry/deployTelemetry', () => ({
  deployTelemetry: {
    trackEventAsync: jest.fn(),
    trackContact: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('Deployment API Routes', () => {
  let mockFastify: any;
  let mockOrchestrator: jest.Mocked<Orchestrator>;
  let mockReply: any;
  let deploymentStore: Map<string, Record<string, any>>;

  beforeEach(() => {
    jest.clearAllMocks();
    deploymentStore = new Map();

    // Create mock Orchestrator
    mockOrchestrator = {
      acquireWorker: jest.fn(),
      releaseWorker: jest.fn(),
      deployAgent: jest.fn(),
      getDeploymentStatus: jest.fn(),
      listDeployments: jest.fn(),
      saveDeploymentRecord: jest.fn(async (record) => {
        deploymentStore.set(record.deploymentId, record);
      }),
      getDeploymentRecord: jest.fn(async (deploymentId) => deploymentStore.get(deploymentId) ?? null),
      deleteDeploymentRecord: jest.fn(async (deploymentId) => {
        deploymentStore.delete(deploymentId);
      }),
      listDeploymentRecords: jest.fn(async () => Array.from(deploymentStore.values())),
      deployPersistentModal: jest.fn().mockResolvedValue({
        endpointUrl: 'https://workspace--auraops-dep.modal.run',
        appName: 'auraops-dep',
      }),
      stopPersistentModal: jest.fn(),
      terminateAgent: jest.fn(),
      registerActiveDeployment: jest.fn(),
      appendDeploymentLog: jest.fn().mockResolvedValue(undefined),
      getStoredDeploymentLogs: jest.fn().mockResolvedValue([]),
      refreshContainerLogs: jest.fn().mockResolvedValue(undefined),
      getContainerLogs: jest.fn().mockResolvedValue([]),
    } as any;

    // Create mock Fastify instance
    mockReply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };

    mockFastify = {
      post: jest.fn((route: string, handler: any) => {
        mockFastify[`_post_${route}`] = handler;
      }),
      get: jest.fn((route: string, handler: any) => {
        mockFastify[`_get_${route}`] = handler;
      }),
      delete: jest.fn((route: string, handler: any) => {
        mockFastify[`_delete_${route}`] = handler;
      }),
    };
  });

  describe('Routes registration', () => {
    it('should register all routes', async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);

      expect(mockFastify.post).toHaveBeenCalledWith(
        '/api/v1/deploy',
        expect.any(Function),
      );
      expect(mockFastify.get).toHaveBeenCalledWith(
        '/api/v1/deployment/:deploymentId',
        expect.any(Function),
      );
      expect(mockFastify.delete).toHaveBeenCalledWith(
        '/api/v1/deployment/:deploymentId',
        expect.any(Function),
      );
      expect(mockFastify.get).toHaveBeenCalledWith(
        '/api/v1/agents',
        expect.any(Function),
      );
      expect(mockFastify.get).toHaveBeenCalledWith(
        '/api/v1/deployment/:deploymentId/logs',
        expect.any(Function),
      );
    });
  });

  describe('GET /api/v1/deployment/:deploymentId/logs', () => {
    let logsHandler: any;
    const deploymentId = '550e8400-e29b-41d4-a716-446655440010';
    const startTime = Date.now() - 5000;

    beforeEach(async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);
      logsHandler = mockFastify['_get_/api/v1/deployment/:deploymentId/logs'];

      deploymentStore.set(deploymentId, {
        deploymentId,
        agentId: 'agent-logs-1',
        workerId: `modal-${deploymentId}`,
        status: 'running',
        startTime,
        estimatedTime: 2500,
        blueprintId: '550e8400-e29b-41d4-a716-446655440000',
        lockfilePath: '/path/to/requirements.lock',
        environmentHash: 'abc123def456',
        endpointUrl: 'https://workspace--auraops-dep.modal.run',
        appName: 'auraops-dep',
        endpointStatus: 'live',
      });
    });

    it('should return lifecycle events before container logs', async () => {
      mockOrchestrator.getContainerLogs.mockResolvedValue([
        {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Agent ready in 1.23s',
          stream: 'stdout',
        },
      ]);

      const request = { params: { deploymentId } };
      await logsHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(200);
      const response = mockReply.send.mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.logs[0].message).toContain('initiated');
      expect(response.logs[response.logs.length - 1].message).toBe('Agent ready in 1.23s');
      expect(mockOrchestrator.getContainerLogs).toHaveBeenCalledWith(
        expect.objectContaining({ deploymentId }),
      );
    });

    it('should include only lifecycle events when no container logs exist', async () => {
      mockOrchestrator.getContainerLogs.mockResolvedValue([]);

      const request = { params: { deploymentId } };
      await logsHandler(request, mockReply);

      const response = mockReply.send.mock.calls[0][0];
      expect(response.logs).toHaveLength(4);
      expect(response.logs[0].message).toContain('initiated');
      expect(response.logs[3].message).toContain('agent is live');
    });

    it('should include failure lifecycle event for failed deployments', async () => {
      deploymentStore.set(deploymentId, {
        ...deploymentStore.get(deploymentId),
        status: 'failed',
        error: 'Modal deployment failed',
        endpointStatus: 'failed',
      });
      mockOrchestrator.getContainerLogs.mockResolvedValue([]);

      const request = { params: { deploymentId } };
      await logsHandler(request, mockReply);

      const response = mockReply.send.mock.calls[0][0];
      expect(response.logs.some((entry: { message: string }) => entry.message === 'Modal deployment failed')).toBe(true);
    });

    it('should return 404 for non-existent deployment', async () => {
      const request = {
        params: { deploymentId: '550e8400-e29b-41d4-a716-446655440099' },
      };

      await logsHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(404);
    });

    it('should validate deployment ID format', async () => {
      const request = { params: { deploymentId: 'invalid-id' } };

      await logsHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid deployment ID format',
        }),
      );
    });

    it('should handle container log fetch errors gracefully', async () => {
      mockOrchestrator.getContainerLogs.mockRejectedValue(
        new DeploymentError('Failed to get deployment logs'),
      );

      const request = { params: { deploymentId } };
      await logsHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /api/v1/deploy', () => {
    let deployHandler: any;

    beforeEach(async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);
      deployHandler = mockFastify['_post_/api/v1/deploy'];
    });

    it('should deploy agent successfully', async () => {
      const mockWorker: WorkerInfo = {
        workerId: 'worker-123',
        gpuId: 'gpu-0',
        ipAddress: '192.168.1.1',
        port: 8000,
        gpuMemoryGB: 16,
        availableGPUMemory: 14,
        provider: 'lambda-labs',
        secureRuntimeActive: true,
      };

      const mockAgent = {
        agentId: 'agent-456',
        status: 'running' as const,
        deploymentTime: 2500,
      };

      mockOrchestrator.acquireWorker.mockResolvedValue(mockWorker);
      mockOrchestrator.deployAgent.mockResolvedValue(mockAgent);

      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      const startTime = Date.now();
      await deployHandler(request, mockReply);
      const responseTime = Date.now() - startTime;

      expect(responseTime).toBeLessThan(50); // API response should be <50ms
      expect(mockReply.code).toHaveBeenCalledWith(201);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          deploymentId: expect.any(String),
          status: 'running',
          endpoint_url: 'https://workspace--auraops-dep.modal.run',
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting Modal deployment'),
      );
    });

    it('should validate blueprint ID format', async () => {
      const request = {
        body: {
          blueprintId: 'invalid-id',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid request',
        }),
      );
    });

    it('should validate required fields', async () => {
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          // missing blueprintJson, lockfilePath, environmentHash
        },
      };

      await deployHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid request',
        }),
      );
    });

    it('should handle Modal deployment failure gracefully', async () => {
      mockOrchestrator.deployPersistentModal.mockRejectedValue(
        new DeploymentError('Modal deployment failed', {
          error: 'Authentication failed',
        }),
      );

      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
        }),
      );
    });

    it('should handle Modal deployment timeout', async () => {
      mockOrchestrator.deployPersistentModal.mockRejectedValue(
        new DeploymentError('Deployment exceeded timeout', { timeout: 30000 }),
      );

      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          modal_deployment_error: expect.any(String),
        }),
      );
    });

    it('should validate Python version format', async () => {
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: 'invalid', // Invalid format
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid request',
        }),
      );
    });

    it('should default gpuCount to 1 when omitted', async () => {
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(mockOrchestrator.deployPersistentModal).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ gpuCount: 1 }),
      );
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ gpuCount: 1 }),
      );
    });

    it('should pass gpuCount to orchestrator and response', async () => {
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
          gpuCount: 4,
        },
      };

      await deployHandler(request, mockReply);

      expect(mockOrchestrator.deployPersistentModal).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ gpuCount: 4 }),
      );
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ gpuCount: 4 }),
      );
    });

    it('should reject gpuCount above 8', async () => {
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
          gpuCount: 9,
        },
      };

      await deployHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
    });

    it('should log successful deployment timing', async () => {
      const mockWorker: WorkerInfo = {
        workerId: 'worker-123',
        gpuId: 'gpu-0',
        ipAddress: '192.168.1.1',
        port: 8000,
        gpuMemoryGB: 16,
        availableGPUMemory: 14,
        provider: 'lambda-labs',
        secureRuntimeActive: true,
      };

      mockOrchestrator.acquireWorker.mockResolvedValue(mockWorker);
      mockOrchestrator.deployAgent.mockResolvedValue({
        agentId: 'agent-456',
        status: 'running',
        deploymentTime: 2500,
      });

      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Persistent Modal endpoint deployed in'),
      );
    });
  });

  describe('GET /api/v1/deployment/:deploymentId', () => {
    let getStatusHandler: any;
    let deploymentId: string;

    beforeEach(async () => {
      // First register routes and deploy an agent
      await deploymentRoutes(mockFastify, mockOrchestrator);
      getStatusHandler = mockFastify['_get_/api/v1/deployment/:deploymentId'];

      // Set up a successful deployment
      const deployHandler = mockFastify['_post_/api/v1/deploy'];
      const mockWorker: WorkerInfo = {
        workerId: 'worker-123',
        gpuId: 'gpu-0',
        ipAddress: '192.168.1.1',
        port: 8000,
        gpuMemoryGB: 16,
        availableGPUMemory: 14,
        provider: 'lambda-labs',
        secureRuntimeActive: true,
      };

      mockOrchestrator.acquireWorker.mockResolvedValue(mockWorker);
      mockOrchestrator.deployAgent.mockResolvedValue({
        agentId: 'agent-456',
        status: 'running',
        deploymentTime: 2500,
      });

      const mockReply2 = { code: jest.fn().mockReturnThis(), send: jest.fn() };
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply2);
      // Extract deployment ID from response
      const response = mockReply2.send.mock.calls[0][0];
      deploymentId = response.deploymentId;
    });

    it('should get deployment status successfully', async () => {
      const mockStatus: DeploymentStatus = {
        agentId: 'agent-456',
        workerId: 'worker-123',
        status: 'running',
        startTime: Date.now() - 5000,
        containerImage: 'auraops/pytorch:cuda12.1-py3.10',
        gpuUtilization: 85,
        lastActivityAt: Date.now(),
      };

      mockOrchestrator.getDeploymentStatus.mockResolvedValue(mockStatus);

      const request = {
        params: { deploymentId },
      };

      const startTime = Date.now();
      await getStatusHandler(request, mockReply);
      const responseTime = Date.now() - startTime;

      expect(responseTime).toBeLessThan(50); // API response should be <50ms
      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'running',
          endpoint_status: 'live',
        }),
      );
    });

    it('should return 404 for non-existent deployment', async () => {
      mockOrchestrator.getDeploymentStatus.mockRejectedValue(
        new DeploymentError('Deployment not found', { agentId: 'unknown' }),
      );

      const request = {
        params: { deploymentId: '550e8400-e29b-41d4-a716-446655440099' },
      };

      await getStatusHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(404);
    });

    it('should validate deployment ID format', async () => {
      const request = {
        params: { deploymentId: 'invalid-id' },
      };

      await getStatusHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid deployment ID format',
        }),
      );
    });

    it('should return gpuCount in status response', async () => {
      const mockStatus: DeploymentStatus = {
        agentId: 'agent-456',
        workerId: 'worker-123',
        status: 'running',
        startTime: Date.now() - 5000,
        containerImage: 'auraops/pytorch:cuda12.1-py3.10',
        lastActivityAt: Date.now(),
      };

      mockOrchestrator.getDeploymentStatus.mockResolvedValue(mockStatus);

      const request = {
        params: { deploymentId },
      };

      await getStatusHandler(request, mockReply);

      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ gpuCount: 1 }),
      );
    });

    it('should omit fake GPU metrics in response', async () => {
      const mockStatus: DeploymentStatus = {
        agentId: 'agent-456',
        workerId: 'worker-123',
        status: 'running',
        startTime: Date.now() - 10000,
        containerImage: 'auraops/pytorch:cuda12.1-py3.10',
        lastActivityAt: Date.now(),
      };

      mockOrchestrator.getDeploymentStatus.mockResolvedValue(mockStatus);

      const request = {
        params: { deploymentId },
      };

      await getStatusHandler(request, mockReply);

      expect(mockReply.send.mock.calls[0][0]).not.toHaveProperty('gpuUtilization');
    });
  });

  describe('DELETE /api/v1/deployment/:deploymentId', () => {
    let deleteHandler: any;

    beforeEach(async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);
      deleteHandler = mockFastify['_delete_/api/v1/deployment/:deploymentId'];

      // Set up a successful deployment first
      const deployHandler = mockFastify['_post_/api/v1/deploy'];
      const mockWorker: WorkerInfo = {
        workerId: 'worker-123',
        gpuId: 'gpu-0',
        ipAddress: '192.168.1.1',
        port: 8000,
        gpuMemoryGB: 16,
        availableGPUMemory: 14,
        provider: 'lambda-labs',
        secureRuntimeActive: true,
      };

      mockOrchestrator.acquireWorker.mockResolvedValue(mockWorker);
      mockOrchestrator.deployAgent.mockResolvedValue({
        agentId: 'agent-456',
        status: 'running',
        deploymentTime: 2500,
      });
      mockOrchestrator.releaseWorker.mockResolvedValue(undefined);

      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);
    });

    it('should release deployment successfully', async () => {
      // Get the deployment ID from the last deployment
      const callArgs = (mockReply.send as jest.Mock).mock.calls;
      const deployResponse = callArgs[0][0];
      const deploymentId = deployResponse.deploymentId;

      const request = {
        params: { deploymentId },
      };

      const startTime = Date.now();
      await deleteHandler(request, mockReply);
      const responseTime = Date.now() - startTime;

      expect(responseTime).toBeLessThan(50); // API response should be <50ms
      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'released',
        }),
      );
      expect(mockOrchestrator.stopPersistentModal).toHaveBeenCalledWith(deploymentId);
      expect(mockOrchestrator.terminateAgent).toHaveBeenCalled();
    });

    it('should validate deployment ID format', async () => {
      const request = {
        params: { deploymentId: 'invalid-id' },
      };

      await deleteHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(400);
    });

    it('should return 404 for non-existent deployment', async () => {
      const request = {
        params: { deploymentId: '550e8400-e29b-41d4-a716-446655440099' },
      };

      await deleteHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(404);
    });

    it('should continue even if worker release fails', async () => {
      mockOrchestrator.releaseWorker.mockRejectedValue(
        new Error('Failed to release worker'),
      );

      // Get the deployment ID from the last deployment
      const callArgs = (mockReply.send as jest.Mock).mock.calls;
      const deployResponse = callArgs[0][0];
      const deploymentId = deployResponse.deploymentId;

      const request = {
        params: { deploymentId },
      };

      await deleteHandler(request, mockReply);

      // Should still return success
      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'released',
        }),
      );
    });
  });

  describe('GET /api/v1/agents', () => {
    let listAgentsHandler: any;

    beforeEach(async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);
      listAgentsHandler = mockFastify['_get_/api/v1/agents'];
    });

    it('should list all deployed agents', async () => {
      const startTime = Date.now() - 10000;
      mockOrchestrator.listDeploymentRecords.mockResolvedValue([
        {
          deploymentId: 'dep-1',
          agentId: 'agent-1',
          workerId: 'worker-1',
          status: 'running',
          startTime,
          estimatedTime: 5000,
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          lockfilePath: '/path/to/lock',
          environmentHash: 'hash',
          gpuType: 'L4',
          gpuCount: 1,
        },
        {
          deploymentId: 'dep-2',
          agentId: 'agent-2',
          workerId: 'worker-2',
          status: 'running',
          startTime: Date.now() - 5000,
          estimatedTime: 5000,
          blueprintId: '550e8400-e29b-41d4-a716-446655440001',
          lockfilePath: '/path/to/lock',
          environmentHash: 'hash',
          gpuType: 'T4',
          gpuCount: 1,
        },
      ]);
      mockOrchestrator.getDeploymentStatus.mockImplementation(async (agentId: string) => ({
        agentId,
        workerId: agentId === 'agent-1' ? 'worker-1' : 'worker-2',
        status: 'running' as const,
        startTime,
        containerImage: 'pytorch:2.1',
        gpuUtilization: agentId === 'agent-1' ? 85 : 92,
        lastActivityAt: Date.now(),
      }));

      const request = { query: {} };

      const reqStart = Date.now();
      await listAgentsHandler(request, mockReply);
      const responseTime = Date.now() - reqStart;

      expect(responseTime).toBeLessThan(50);
      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          agents: expect.arrayContaining([
            expect.objectContaining({ agentId: 'agent-1', status: 'running' }),
            expect.objectContaining({ agentId: 'agent-2', status: 'running' }),
          ]),
          total: 2,
        }),
      );
    });

    it('should return empty list when no deployments exist', async () => {
      mockOrchestrator.listDeploymentRecords.mockResolvedValue([]);

      const request = { query: {} };

      await listAgentsHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          agents: [],
          total: 0,
        }),
      );
    });

    it('should include gpuCount in agent list', async () => {
      mockOrchestrator.listDeploymentRecords.mockResolvedValue([
        {
          deploymentId: 'dep-1',
          agentId: 'agent-1',
          workerId: 'worker-1',
          status: 'running',
          startTime: Date.now() - 10000,
          estimatedTime: 5000,
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          lockfilePath: '/path/to/lock',
          environmentHash: 'hash',
          gpuCount: 2,
          gpuType: 'A100',
        },
      ]);
      mockOrchestrator.getDeploymentStatus.mockResolvedValue({
        agentId: 'agent-1',
        workerId: 'worker-1',
        status: 'running',
        startTime: Date.now() - 10000,
        containerImage: 'pytorch:2.1',
        lastActivityAt: Date.now(),
      });

      const request = { query: {} };

      await listAgentsHandler(request, mockReply);

      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: expect.arrayContaining([
            expect.objectContaining({ gpuCount: 2 }),
          ]),
        }),
      );
    });

    it('should include GPU utilization in agent list', async () => {
      mockOrchestrator.listDeploymentRecords.mockResolvedValue([
        {
          deploymentId: 'dep-1',
          agentId: 'agent-1',
          workerId: 'worker-1',
          status: 'running',
          startTime: Date.now() - 10000,
          estimatedTime: 5000,
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          lockfilePath: '/path/to/lock',
          environmentHash: 'hash',
          gpuType: 'L4',
        },
      ]);
      mockOrchestrator.getDeploymentStatus.mockResolvedValue({
        agentId: 'agent-1',
        workerId: 'worker-1',
        status: 'running',
        startTime: Date.now() - 10000,
        containerImage: 'pytorch:2.1',
        gpuUtilization: 87,
        lastActivityAt: Date.now(),
      });

      const request = { query: {} };

      await listAgentsHandler(request, mockReply);

      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: expect.arrayContaining([
            expect.objectContaining({
              gpuUtilization: 87,
            }),
          ]),
        }),
      );
    });

    it('should calculate agent uptime correctly', async () => {
      const startTime = Date.now() - 30000;
      mockOrchestrator.listDeploymentRecords.mockResolvedValue([
        {
          deploymentId: 'dep-1',
          agentId: 'agent-1',
          workerId: 'worker-1',
          status: 'running',
          startTime,
          estimatedTime: 5000,
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          lockfilePath: '/path/to/lock',
          environmentHash: 'hash',
          gpuType: 'T4',
        },
      ]);
      mockOrchestrator.getDeploymentStatus.mockResolvedValue({
        agentId: 'agent-1',
        workerId: 'worker-1',
        status: 'running',
        startTime,
        containerImage: 'pytorch:2.1',
        gpuUtilization: 85,
        lastActivityAt: Date.now(),
      });

      const request = { query: {} };

      await listAgentsHandler(request, mockReply);

      const callArgs = (mockReply.send as jest.Mock).mock.calls[0][0];
      const uptime = callArgs.agents[0].uptime;

      // Uptime should be approximately 30 seconds (allow 100ms margin)
      expect(uptime).toBeGreaterThanOrEqual(29900);
      expect(uptime).toBeLessThanOrEqual(30100);
    });

    it('should handle orchestrator failure gracefully', async () => {
      mockOrchestrator.listDeploymentRecords.mockRejectedValue(
        new DeploymentError('Failed to list deployments', {}),
      );

      const request = { query: {} };

      await listAgentsHandler(request, mockReply);

      // Should return 200 with empty list (graceful degradation)
      expect(mockReply.code).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          agents: [],
          total: 0,
        }),
      );
    });

    it('should log list operation timing', async () => {
      mockOrchestrator.listDeployments.mockResolvedValue([]);

      const request = { query: {} };

      await listAgentsHandler(request, mockReply);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Listed'),
      );
    });
  });

  describe('Error handling', () => {
    let deployHandler: any;

    beforeEach(async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);
      deployHandler = mockFastify['_post_/api/v1/deploy'];
    });

    it('should handle internal server errors', async () => {
      mockOrchestrator.deployPersistentModal.mockRejectedValue(
        new Error('Unexpected internal error'),
      );

      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(mockReply.code).toHaveBeenCalledWith(500);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          modal_deployment_error: expect.any(String),
        }),
      );
    });

    it('should log errors with details', async () => {
      mockOrchestrator.deployPersistentModal.mockRejectedValue(
        new DeploymentError('Modal deployment failed', {
          timeout: 5000,
        }),
      );

      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      await deployHandler(request, mockReply);

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('Performance targets', () => {
    let deployHandler: any;
    let getStatusHandler: any;
    let listAgentsHandler: any;

    beforeEach(async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);
      deployHandler = mockFastify['_post_/api/v1/deploy'];
      getStatusHandler = mockFastify['_get_/api/v1/deployment/:deploymentId'];
      listAgentsHandler = mockFastify['_get_/api/v1/agents'];

      const mockWorker: WorkerInfo = {
        workerId: 'worker-123',
        gpuId: 'gpu-0',
        ipAddress: '192.168.1.1',
        port: 8000,
        gpuMemoryGB: 16,
        availableGPUMemory: 14,
        provider: 'lambda-labs',
        secureRuntimeActive: true,
      };

      mockOrchestrator.acquireWorker.mockResolvedValue(mockWorker);
      mockOrchestrator.deployAgent.mockResolvedValue({
        agentId: 'agent-456',
        status: 'running',
        deploymentTime: 2500,
      });
    });

    it('should handle deployment API request in <50ms', async () => {
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      const startTime = Date.now();
      await deployHandler(request, mockReply);
      const responseTime = Date.now() - startTime;

      expect(responseTime).toBeLessThan(50);
    });

    it('should handle status check API request in <50ms', async () => {
      mockOrchestrator.getDeploymentStatus.mockResolvedValue({
        agentId: 'agent-456',
        workerId: 'worker-123',
        status: 'running',
        startTime: Date.now() - 5000,
        containerImage: 'auraops/pytorch:cuda12.1-py3.10',
        gpuUtilization: 85,
        lastActivityAt: Date.now(),
      });

      const request = {
        params: { deploymentId: '550e8400-e29b-41d4-a716-446655440001' },
      };

      const startTime = Date.now();
      await getStatusHandler(request, mockReply);
      const responseTime = Date.now() - startTime;

      expect(responseTime).toBeLessThan(50);
    });

    it('should handle list agents API request in <50ms', async () => {
      mockOrchestrator.listDeployments.mockResolvedValue([]);

      const request = { query: {} };

      const startTime = Date.now();
      await listAgentsHandler(request, mockReply);
      const responseTime = Date.now() - startTime;

      expect(responseTime).toBeLessThan(50);
    });
  });

  describe('Concurrent requests', () => {
    let deployHandler: any;

    beforeEach(async () => {
      await deploymentRoutes(mockFastify, mockOrchestrator);
      deployHandler = mockFastify['_post_/api/v1/deploy'];

      const mockWorker: WorkerInfo = {
        workerId: 'worker-123',
        gpuId: 'gpu-0',
        ipAddress: '192.168.1.1',
        port: 8000,
        gpuMemoryGB: 16,
        availableGPUMemory: 14,
        provider: 'lambda-labs',
        secureRuntimeActive: true,
      };

      mockOrchestrator.acquireWorker.mockResolvedValue(mockWorker);
      mockOrchestrator.deployAgent.mockResolvedValue({
        agentId: 'agent-456',
        status: 'running',
        deploymentTime: 2500,
      });
    });

    it('should handle multiple concurrent deployments', async () => {
      const request = {
        body: {
          blueprintId: '550e8400-e29b-41d4-a716-446655440000',
          blueprintJson: {
            id: 'blueprint-1',
            timestamp: new Date().toISOString(),
            framework: {
              framework: 'pytorch',
              version: '2.1.0',
              cudaVersion: '12.1',
              pythonVersion: '3.10',
              primaryUse: 'inference',
            },
            systemRequirements: {
              baseImageId: 'auraops/pytorch',
              baseImageTag: 'cuda12.1-py3.10',
            },
          },
          lockfilePath: '/path/to/requirements.lock',
          environmentHash: 'abc123def456',
          gpuRequirements: {
            minMemory: 8,
            framework: 'pytorch',
            pythonVersion: '3.10',
          },
        },
      };

      const mockReply2 = { code: jest.fn().mockReturnThis(), send: jest.fn() };
      const mockReply3 = { code: jest.fn().mockReturnThis(), send: jest.fn() };

      await Promise.all([
        deployHandler(request, mockReply),
        deployHandler(request, mockReply2),
        deployHandler(request, mockReply3),
      ]);

      // All requests should succeed
      expect(mockReply.code).toHaveBeenCalledWith(201);
      expect(mockReply2.code).toHaveBeenCalledWith(201);
      expect(mockReply3.code).toHaveBeenCalledWith(201);

      // Each should have unique deployment IDs
      const id1 = mockReply.send.mock.calls[0][0].deploymentId;
      const id2 = mockReply2.send.mock.calls[0][0].deploymentId;
      const id3 = mockReply3.send.mock.calls[0][0].deploymentId;

      expect(new Set([id1, id2, id3]).size).toBe(3);
    });
  });
});
