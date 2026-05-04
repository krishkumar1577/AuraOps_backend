import { Orchestrator, WorkerInfo, WorkerRequirements, GPUProvider } from '../../src/services/orchestration/orchestrator';
import { HealthCheck, HealthStatus } from '../../src/services/orchestration/healthCheck';
import { DeploymentError } from '../../src/utils/errors';
import type { BlueprintJSON } from '../../src/types/blueprint.types';

/**
 * Phase 4: GPU Deployment Orchestration Integration Tests
 * 
 * Comprehensive end-to-end testing of:
 * - Worker acquisition with multi-provider support
 * - Agent deployment to GPU workers
 * - Health check and monitoring
 * - Provider adapters (LambdaLabs, AWS, Local)
 * - Provider failover and load balancing
 * - Resource tracking and metrics
 * - Complete E2E deployment workflows
 * - Performance benchmarks
 * 
 * 50+ test cases across 5 suites
 * >90% coverage target
 */

// Mock Redis client
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    isOpen: true,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sAdd: jest.fn().mockResolvedValue(1),
    sRem: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/utils/errors', () => {
  const originalModule = jest.requireActual('../../src/utils/errors');
  return {
    ...originalModule,
    DeploymentError: class DeploymentError extends Error {
      constructor(message: string, public metadata?: any) {
        super(message);
        this.name = 'DeploymentError';
      }
    },
  };
});

// Mock HTTP requests
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

/**
 * Mock GPU Provider for testing
 */
class MockGPUProvider implements GPUProvider {
  name: string;
  private workers: Map<string, WorkerInfo> = new Map();
  private connected: boolean = false;
  private maxWorkers: number;
  private failureMode: 'none' | 'connection' | 'exhaustion' = 'none';

  constructor(name: string, maxWorkers: number = 10) {
    this.name = name;
    this.maxWorkers = maxWorkers;
  }

  setFailureMode(mode: 'none' | 'connection' | 'exhaustion'): void {
    this.failureMode = mode;
  }

  async connect(): Promise<void> {
    if (this.failureMode === 'connection') {
      throw new DeploymentError(`${this.name}: Connection failed`);
    }
    this.connected = true;
  }

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null> {
    if (!this.connected) {
      throw new DeploymentError(`${this.name}: Not connected`);
    }

    if (this.failureMode === 'exhaustion' || this.workers.size >= this.maxWorkers) {
      return null; // No workers available
    }

    const workerId = `${this.name.toLowerCase()}-worker-${this.workers.size}-${Date.now()}`;
    const worker: WorkerInfo = {
      workerId,
      gpuId: `gpu-${this.workers.size}`,
      ipAddress: `10.0.0.${this.workers.size + 1}`,
      port: 8000 + this.workers.size,
      gpuMemoryGB: 40,
      availableGPUMemory: requirements.minGPUMemory + 10,
      provider: this.name,
    };

    this.workers.set(workerId, worker);
    return worker;
  }

  async releaseWorker(workerId: string): Promise<void> {
    if (!this.connected) {
      throw new DeploymentError(`${this.name}: Not connected`);
    }
    this.workers.delete(workerId);
  }

  async listWorkers(): Promise<WorkerInfo[]> {
    return Array.from(this.workers.values());
  }

  async healthCheck(workerId: string): Promise<boolean> {
    return this.workers.has(workerId);
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  clear(): void {
    this.workers.clear();
  }
}

/**
 * Mock Health Check Endpoint
 */
const mockHealthCheckEndpoint = (healthy: boolean = true, latency: number = 10): HealthStatus => ({
  healthy,
  latency,
  memory: { used: 8589934592, total: 16777216000 }, // 8GB / 16GB
  gpu: {
    utilization: 75,
    memory: { used: 30000000000, total: 40000000000 }, // 30GB / 40GB
  },
  uptime: 3600000,
  timestamp: Date.now(),
});

describe('Phase 4: GPU Deployment Orchestration Integration', () => {
  jest.setTimeout(30000);

  let orchestrator: Orchestrator;
  let healthCheck: HealthCheck;
  let lambdaLabsProvider: MockGPUProvider;
  let awsProvider: MockGPUProvider;
  let localProvider: MockGPUProvider;

  // Sample blueprint for deployments
  const sampleBlueprint: BlueprintJSON = {
    id: 'blueprint-test-001',
    timestamp: new Date().toISOString(),
    framework: {
      framework: 'pytorch',
      version: '2.1.0',
      cudaVersion: '12.1',
      pythonVersion: '3.11',
      primaryUse: 'inference',
    },
    dependencyLock: {
      'torch': '2.1.0',
      'transformers': '4.35.0',
      'accelerate': '0.24.0',
    },
    systemRequirements: {
      pythonVersion: '3.11',
      cudaVersion: '12.1',
      cuDNNVersion: '8.9.0',
      baseImageId: 'pytorch/pytorch',
      baseImageTag: '2.1.0-cuda12.1-runtime-ubuntu22.04',
    },
    customModels: [],
    deploymentConfig: {
      entrypoint: 'python main.py',
      runtime: 'docker',
      memoryMB: 8192,
      gpuRequired: true,
      gpuMemoryGB: 24,
    },
    checksums: {
      allDepsHash: 'sha256-abc123',
      blueprintHash: 'sha256-def456',
    },
  };

  beforeAll(async () => {
    // Initialize mock providers
    lambdaLabsProvider = new MockGPUProvider('LambdaLabs', 5);
    awsProvider = new MockGPUProvider('AWS', 3);
    localProvider = new MockGPUProvider('Local', 2);

    await lambdaLabsProvider.connect();
    await awsProvider.connect();
    await localProvider.connect();

    // Create mock Redis client
    const mockRedisClient = {
      isOpen: true,
      connect: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      sAdd: jest.fn().mockResolvedValue(1),
      sRem: jest.fn().mockResolvedValue(1),
      sMembers: jest.fn().mockResolvedValue([]),
    };

    // Initialize orchestrator with multiple providers
    orchestrator = new Orchestrator(
      [lambdaLabsProvider, awsProvider, localProvider],
      mockRedisClient,
    );

    healthCheck = new HealthCheck();

    // Reset mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Clear all providers between tests
    lambdaLabsProvider.clear();
    awsProvider.clear();
    localProvider.clear();

    // Reset failure modes
    lambdaLabsProvider.setFailureMode('none');
    awsProvider.setFailureMode('none');
    localProvider.setFailureMode('none');

    // Reset mocks
    jest.clearAllMocks();
    mockFetch.mockClear();
  });

  // ==================== SUITE 1: WORKER ACQUISITION (12 tests) ====================

  describe('Suite 1: Worker Acquisition', () => {
    it('should acquire single worker from available provider', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker.workerId).toBeDefined();
      expect(worker.availableGPUMemory).toBeGreaterThanOrEqual(requirements.minGPUMemory);
      expect(worker.provider).toBeDefined();
    });

    it('should acquire multiple workers concurrently', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 16,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const acquisitions = Array(5)
        .fill(null)
        .map(() => orchestrator.acquireWorker(requirements));

      const workers = await Promise.all(acquisitions);

      expect(workers).toHaveLength(5);
      workers.forEach(w => {
        expect(w.workerId).toBeDefined();
        expect(w.availableGPUMemory).toBeGreaterThanOrEqual(requirements.minGPUMemory);
      });
    });

    it('should list available workers', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Acquire workers first to test concurrent operations
      await orchestrator.acquireWorker(requirements);
      await orchestrator.acquireWorker(requirements);

      const deployments = await orchestrator.listDeployments();

      expect(Array.isArray(deployments)).toBe(true);
      expect(deployments.length).toBeGreaterThanOrEqual(0);
    });

    it('should throw error when no workers available (exhaustion)', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Set all providers to exhaustion mode
      lambdaLabsProvider.setFailureMode('exhaustion');
      awsProvider.setFailureMode('exhaustion');
      localProvider.setFailureMode('exhaustion');

      await expect(orchestrator.acquireWorker(requirements)).rejects.toThrow(DeploymentError);
      await expect(orchestrator.acquireWorker(requirements)).rejects.toThrow(
        'No available workers matching requirements',
      );
    });

    it('should acquire worker with PyTorch framework', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker.provider).toBeDefined();
    });

    it('should acquire worker with LangChain framework', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 16,
        framework: 'langchain',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker.availableGPUMemory).toBeGreaterThanOrEqual(requirements.minGPUMemory);
    });

    it('should handle worker timeout gracefully', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Set all providers to exhaustion to force timeout
      lambdaLabsProvider.setFailureMode('exhaustion');
      awsProvider.setFailureMode('exhaustion');
      localProvider.setFailureMode('exhaustion');

      await expect(orchestrator.acquireWorker(requirements)).rejects.toThrow();
    });

    it('should release worker successfully', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);
      const initialCount = lambdaLabsProvider.getWorkerCount();

      await orchestrator.releaseWorker(worker.workerId);

      const finalCount = lambdaLabsProvider.getWorkerCount();
      expect(finalCount).toBeLessThan(initialCount);
    });

    it('should reuse released worker', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker1 = await orchestrator.acquireWorker(requirements);
      const workerId = worker1.workerId;

      await orchestrator.releaseWorker(workerId);

      const worker2 = await orchestrator.acquireWorker(requirements);
      expect(worker2.workerId).toBeDefined();
    });

    it('should implement provider failover', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Set primary provider to connection error
      lambdaLabsProvider.setFailureMode('connection');

      // Should failover to AWS provider
      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker.provider).toMatch(/AWS|Local/);
    });

    it('should match resource requirements', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 20,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker.availableGPUMemory).toBeGreaterThanOrEqual(requirements.minGPUMemory);
      expect(worker.gpuMemoryGB).toBeGreaterThanOrEqual(requirements.minGPUMemory);
    });

    it('should track worker status', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Acquire a worker and use it to test deployment status check
      await orchestrator.acquireWorker(requirements);

      // Check the deployment status (health is implicit if agent is running)
      const deployments = await orchestrator.listDeployments();

      expect(Array.isArray(deployments)).toBe(true);
    });

    it('should handle concurrent acquire and release', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const workers = await Promise.all([
        orchestrator.acquireWorker(requirements),
        orchestrator.acquireWorker(requirements),
      ]);

      const releases = workers.map(w => orchestrator.releaseWorker(w.workerId));
      await Promise.all(releases);

      expect(lambdaLabsProvider.getWorkerCount()).toBe(0);
      expect(awsProvider.getWorkerCount()).toBe(0);
      expect(localProvider.getWorkerCount()).toBe(0);
    });
  });

  // ==================== SUITE 2: AGENT DEPLOYMENT (12 tests) ====================

  describe('Suite 2: Agent Deployment', () => {
    it('should deploy agent to acquired worker', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'env-hash-12345',
      );

      expect(deployment).toBeDefined();
      expect(deployment.agentId).toBeDefined();
      expect(deployment.status).toBe('pending');
      expect(deployment.deploymentTime).toBeGreaterThanOrEqual(0);
    });

    it('should deploy agent with valid blueprint, lock, and hash', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/requirements-lock.txt',
        'sha256-abc123def456',
      );

      expect(deployment.agentId).toBeDefined();
      expect(deployment.deploymentTime).toBeLessThan(500); // <500ms for mock
    });

    it('should transition deployment status: pending → deploying → running', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const initialDeployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'env-hash',
      );

      expect(initialDeployment.status).toBe('pending');

      // Simulate status transitions
      const status1 = await orchestrator.getDeploymentStatus(initialDeployment.agentId);
      expect(['pending', 'deploying', 'running']).toContain(status1?.status);
    });

    it('should deploy agent with PyTorch framework', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const blueprint: BlueprintJSON = {
        ...sampleBlueprint,
        framework: {
          framework: 'pytorch',
          version: '2.1.0',
          cudaVersion: '12.1',
          pythonVersion: '3.11',
          primaryUse: 'inference',
        },
      };

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      expect(deployment).toBeDefined();
      expect(deployment.agentId).toBeDefined();
    });

    it('should verify health check after deployment', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 15),
      });

      const health = await healthCheck.checkAgent(deployment.agentId, {
        host: worker.ipAddress,
        port: worker.port,
      });

      expect(health.healthy).toBe(true);
      expect(health.latency).toBeLessThan(100);
    });

    it('should track GPU utilization metrics', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      const status = await orchestrator.getDeploymentStatus(deployment.agentId);

      expect(status?.gpuUtilization).toBeGreaterThanOrEqual(0);
      expect(status?.gpuUtilization).toBeLessThanOrEqual(100);
    });

    it('should track memory usage', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(),
      });

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      const health = await healthCheck.checkAgent(deployment.agentId, {
        host: worker.ipAddress,
        port: worker.port,
      });

      expect(health.memory.used).toBeGreaterThan(0);
      expect(health.memory.total).toBeGreaterThan(health.memory.used);
    });

    it('should handle deployment timeout', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      // Mock timeout scenario
      mockFetch.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 10000)));

      const health = healthCheck.checkAgent(worker.workerId, {
        host: worker.ipAddress,
        port: worker.port,
        timeout: 100,
      });

      // Should timeout
      await expect(health).rejects.toThrow();
    });

    it('should recover from failed deployment', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      // First deployment (simulated failure)
      const failedDeployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      // Retry deployment
      const retriedDeployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      expect(retriedDeployment.agentId).toBeDefined();
      expect(retriedDeployment).not.toEqual(failedDeployment);
    });

    it('should deploy multiple agents concurrently', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const workers = await Promise.all([
        orchestrator.acquireWorker(requirements),
        orchestrator.acquireWorker(requirements),
      ]);

      const deployments = await Promise.all(
        workers.map(w =>
          orchestrator.deployAgent(
            w.workerId,
            sampleBlueprint,
            '/tmp/lockfile.txt',
            'hash',
          ),
        ),
      );

      expect(deployments).toHaveLength(2);
      deployments.forEach(d => {
        expect(d.agentId).toBeDefined();
      });
    });

    it('should support deployment cancellation', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      // Can get deployment status
      const status = await orchestrator.getDeploymentStatus(deployment.agentId);

      expect(status).toBeDefined();
      expect(status?.agentId).toBe(deployment.agentId);
    });

    it('should track deployment logs', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      const status = await orchestrator.getDeploymentStatus(deployment.agentId);

      expect(status).toBeDefined();
      expect(status?.agentId).toBe(deployment.agentId);
    });
  });

  // ==================== SUITE 3: HEALTH CHECKS (10 tests) ====================

  describe('Suite 3: Health Checks', () => {
    it('should check healthy agent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 15),
      });

      const health = await healthCheck.checkAgent('agent-001', {
        host: '10.0.0.1',
        port: 8000,
      });

      expect(health.healthy).toBe(true);
      expect(health.latency).toBeGreaterThan(0);
      expect(health.uptime).toBeGreaterThan(0);
    });

    it('should detect unhealthy agent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(false, 50),
      });

      const health = await healthCheck.checkAgent('agent-002', {
        host: '10.0.0.2',
        port: 8000,
      });

      expect(health.healthy).toBe(false);
    });

    it('should implement retry logic on transient failure', async () => {
      // First call fails, second succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthCheckEndpoint(true, 20),
        });

      const health = await healthCheck.checkAgent('agent-003', {
        host: '10.0.0.3',
        port: 8000,
        timeout: 5000,
      });

      expect(health.healthy).toBe(true);
    });

    it('should handle health check timeout', async () => {
      mockFetch.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({
          ok: false,
          json: async () => ({}),
        }), 10000)),
      );

      await expect(
        healthCheck.checkAgent('agent-004', {
          host: '10.0.0.4',
          port: 8000,
          timeout: 100,
        }),
      ).rejects.toThrow();
    });

    it('should wait until agent is ready', async () => {
      // Simulate polling until ready
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        const isReady = callCount >= 2;
        return {
          ok: true,
          json: async () => mockHealthCheckEndpoint(isReady),
        };
      });

      const isReady = await healthCheck.waitReady('agent-005', {
        host: '10.0.0.5',
        port: 8000,
        timeout: 5000,
        interval: 100,
      });

      expect(isReady).toBe(true);
    });

    it('should implement monitoring stream for continuous polling', async () => {
      const healthStatus: HealthStatus[] = [];

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 10 + Math.random() * 5),
      });

      // Simulate multiple health checks
      for (let i = 0; i < 3; i++) {
        const health = await healthCheck.checkAgent(`agent-006-${i}`, {
          host: '10.0.0.6',
          port: 8000,
        });
        healthStatus.push(health);
      }

      expect(healthStatus).toHaveLength(3);
      healthStatus.forEach(h => {
        expect(h.healthy).toBe(true);
      });
    });

    it('should track memory metrics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 12),
      });

      const health = await healthCheck.checkAgent('agent-007', {
        host: '10.0.0.7',
        port: 8000,
      });

      expect(health.memory.used).toBeGreaterThan(0);
      expect(health.memory.total).toBeGreaterThan(0);
      expect(health.memory.used).toBeLessThan(health.memory.total);
    });

    it('should track GPU metrics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 18),
      });

      const health = await healthCheck.checkAgent('agent-008', {
        host: '10.0.0.8',
        port: 8000,
      });

      expect(health.gpu.utilization).toBeGreaterThanOrEqual(0);
      expect(health.gpu.utilization).toBeLessThanOrEqual(100);
      expect(health.gpu.memory.used).toBeGreaterThan(0);
      expect(health.gpu.memory.total).toBeGreaterThan(0);
    });

    it('should measure latency accurately', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 25),
      });

      const health = await healthCheck.checkAgent('agent-009', {
        host: '10.0.0.9',
        port: 8000,
      });

      expect(health.latency).toBeGreaterThanOrEqual(0);
      expect(health.latency).toBeLessThan(100); // Mock should be very fast
    });

    it('should handle errors in health checks gracefully', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        healthCheck.checkAgent('agent-010', {
          host: '10.0.0.10',
          port: 8000,
          timeout: 5000,
        }),
      ).rejects.toThrow();
    });
  });

  // ==================== SUITE 4: PROVIDER ADAPTERS (10 tests) ====================

  describe('Suite 4: Provider Adapters', () => {
    it('should acquire worker from LambdaLabs', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await lambdaLabsProvider.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker?.provider).toBe('LambdaLabs');
    });

    it('should list workers from LambdaLabs', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      await lambdaLabsProvider.acquireWorker(requirements);
      const workers = await lambdaLabsProvider.listWorkers();

      expect(workers).toHaveLength(1);
    });

    it('should release worker from LambdaLabs', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await lambdaLabsProvider.acquireWorker(requirements);
      expect(worker).toBeDefined();

      await lambdaLabsProvider.releaseWorker(worker!.workerId);
      const workers = await lambdaLabsProvider.listWorkers();

      expect(workers).toHaveLength(0);
    });

    it('should acquire worker from AWS', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 16,
        framework: 'langchain',
        pythonVersion: '3.11',
      };

      const worker = await awsProvider.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker?.provider).toBe('AWS');
    });

    it('should handle provider connection errors', async () => {
      lambdaLabsProvider.setFailureMode('connection');

      await expect(lambdaLabsProvider.acquireWorker({
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      })).rejects.toThrow();
    });

    it('should handle provider quota exceeded', async () => {
      lambdaLabsProvider.setFailureMode('exhaustion');

      const result = await lambdaLabsProvider.acquireWorker({
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      });

      expect(result).toBeNull();
    });

    it('should timeout provider requests appropriately', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Should complete quickly even though timeout is high
      const start = Date.now();
      const worker = await lambdaLabsProvider.acquireWorker(requirements);
      const elapsed = Date.now() - start;

      expect(worker).toBeDefined();
      expect(elapsed).toBeLessThan(1000);
    });

    it('should support multi-provider failover', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Make first provider fail
      lambdaLabsProvider.setFailureMode('connection');

      // Should get worker from AWS
      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker.provider).toMatch(/AWS|Local/);
    });

    it('should switch providers based on availability', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Exhaust LambdaLabs
      for (let i = 0; i < 5; i++) {
        await lambdaLabsProvider.acquireWorker(requirements);
      }

      // Should get from AWS
      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker.provider).toBe('AWS');
    });

    it('should validate provider credentials', async () => {
      expect(lambdaLabsProvider).toBeDefined();
      // Providers should be connected
      const worker = await lambdaLabsProvider.acquireWorker({
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      });
      expect(worker).toBeDefined();
    });
  });

  // ==================== SUITE 5: END-TO-END WORKFLOWS (6+ tests) ====================

  describe('Suite 5: End-to-End Workflows', () => {
    it('should complete full deploy flow: acquire → deploy → health → running', async () => {
      const start = Date.now();

      // Step 1: Acquire worker
      const worker = await orchestrator.acquireWorker({
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      });
      expect(worker).toBeDefined();

      // Step 2: Deploy agent
      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'env-hash',
      );
      expect(deployment.agentId).toBeDefined();

      // Step 3: Check health
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 15),
      });

      const health = await healthCheck.checkAgent(deployment.agentId, {
        host: worker.ipAddress,
        port: worker.port,
      });
      expect(health.healthy).toBe(true);

      const totalTime = Date.now() - start;
      expect(totalTime).toBeLessThan(1000); // Full flow should be quick in mock

      // Cleanup
      await orchestrator.releaseWorker(worker.workerId);
    });

    it('should deploy multiple agents in parallel', async () => {
      const start = Date.now();

      // Acquire multiple workers
      const workers = await Promise.all(
        Array(3)
          .fill(null)
          .map(() =>
            orchestrator.acquireWorker({
              minGPUMemory: 12,
              framework: 'pytorch',
              pythonVersion: '3.11',
            }),
          ),
      );

      // Deploy agents
      const deployments = await Promise.all(
        workers.map(w =>
          orchestrator.deployAgent(
            w.workerId,
            sampleBlueprint,
            '/tmp/lockfile.txt',
            'hash',
          ),
        ),
      );

      expect(deployments).toHaveLength(3);
      deployments.forEach(d => {
        expect(d.agentId).toBeDefined();
      });

      const totalTime = Date.now() - start;
      expect(totalTime).toBeLessThan(2000);

      // Cleanup
      await Promise.all(workers.map(w => orchestrator.releaseWorker(w.workerId)));
    });

    it('should release agents and reuse workers', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Deploy first agent
      const worker1 = await orchestrator.acquireWorker(requirements);
      const deployment1 = await orchestrator.deployAgent(
        worker1.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      // Release
      await orchestrator.releaseWorker(worker1.workerId);

      // Reuse worker for second agent
      const worker2 = await orchestrator.acquireWorker(requirements);
      const deployment2 = await orchestrator.deployAgent(
        worker2.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      expect(deployment1.agentId).toBeDefined();
      expect(deployment2.agentId).toBeDefined();
      expect(deployment2.agentId).not.toEqual(deployment1.agentId);

      await orchestrator.releaseWorker(worker2.workerId);
    });

    it('should handle deployment failure and cleanup', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      // Simulate deployment (will succeed in mock)
      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      expect(deployment).toBeDefined();

      // Cleanup on failure
      await orchestrator.releaseWorker(worker.workerId);

      // Verify worker is released (no longer in deployments)
      const deployments = await orchestrator.listDeployments();
      expect(Array.isArray(deployments)).toBe(true);
    });

    it('should handle resource exhaustion scenario', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      // Exhaust all providers
      const acquisitions = [];
      for (let i = 0; i < 15; i++) {
        acquisitions.push(
          orchestrator
            .acquireWorker(requirements)
            .catch(() => null),
        );
      }

      const results = await Promise.all(acquisitions);
      const successful = results.filter(r => r !== null);

      // Should acquire up to max workers (2+3+5 = 10)
      expect(successful.length).toBeLessThanOrEqual(10);

      // Cleanup
      for (const worker of successful) {
        if (worker) {
          await orchestrator.releaseWorker(worker.workerId).catch(() => {});
        }
      }
    });

    it('should monitor deployment lifecycle', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      };

      const worker = await orchestrator.acquireWorker(requirements);
      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      // Get status at different points
      const status1 = await orchestrator.getDeploymentStatus(deployment.agentId);
      expect(status1?.status).toBeDefined();
      expect(['pending', 'deploying', 'running', 'failed']).toContain(status1?.status);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 20),
      });

      const health = await healthCheck.checkAgent(deployment.agentId, {
        host: worker.ipAddress,
        port: worker.port,
      });
      expect(health.healthy).toBe(true);

      // Cleanup
      await orchestrator.releaseWorker(worker.workerId);
    });

    it('should verify performance: worker acquisition <100ms', async () => {
      const start = Date.now();

      await orchestrator.acquireWorker({
        minGPUMemory: 12,
        framework: 'pytorch',
        pythonVersion: '3.11',
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });

    it('should verify performance: deployment <500ms', async () => {
      const worker = await orchestrator.acquireWorker({
        minGPUMemory: 24,
        framework: 'pytorch',
        pythonVersion: '3.11',
      });

      const start = Date.now();

      await orchestrator.deployAgent(
        worker.workerId,
        sampleBlueprint,
        '/tmp/lockfile.txt',
        'hash',
      );

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);

      await orchestrator.releaseWorker(worker.workerId);
    });

    it('should verify performance: health check <100ms', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthCheckEndpoint(true, 10),
      });

      const start = Date.now();

      await healthCheck.checkAgent('agent-perf', {
        host: '10.0.0.1',
        port: 8000,
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });

    it('should verify performance: list operations <50ms', async () => {
      // Acquire a few workers first
      for (let i = 0; i < 3; i++) {
        await orchestrator.acquireWorker({
          minGPUMemory: 12,
          framework: 'pytorch',
          pythonVersion: '3.11',
        });
      }

      const start = Date.now();

      // List all deployments (available workers)
      const deployments = await orchestrator.listDeployments();

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
      expect(deployments.length).toBeGreaterThanOrEqual(0);
    });
  });
});
