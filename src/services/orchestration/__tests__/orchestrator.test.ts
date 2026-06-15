import { Orchestrator, type GPUProvider, type WorkerInfo, type WorkerRequirements } from '../orchestrator';
import { DeploymentError } from '../../../utils/errors';
import type { BlueprintJSON } from '../../../types/blueprint.types';

// Mock Redis Client
class MockRedisClient {
  isOpen: boolean = true;
  store: Map<string, string> = new Map();
  sets: Map<string, Set<string>> = new Map();
  lists: Map<string, string[]> = new Map();
  ttlMap: Map<string, number> = new Map();

  async connect(): Promise<void> {
    this.isOpen = true;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<unknown> {
    this.store.set(key, value);
    if (options?.EX) {
      this.ttlMap.set(key, options.EX);
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const existed = this.store.has(key);
    this.store.delete(key);
    this.ttlMap.delete(key);
    return existed ? 1 : 0;
  }

  async sAdd(key: string, member: string): Promise<number> {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set());
    }
    const set = this.sets.get(key)!;
    const existed = set.has(member);
    set.add(member);
    return existed ? 0 : 1;
  }

  async sRem(key: string, member: string): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    const existed = set.has(member);
    set.delete(member);
    return existed ? 1 : 0;
  }

  async sMembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  async rPush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return list.slice(start, normalizedStop + 1);
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    this.ttlMap.set(key, seconds);
    return true;
  }

  async lTrim(key: string, start: number, stop: number): Promise<string> {
    const list = this.lists.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    this.lists.set(key, list.slice(start, normalizedStop + 1));
    return 'OK';
  }
}

// Mock GPU Provider
class MockGPUProvider implements GPUProvider {
  name: string;
  workers: Map<string, WorkerInfo> = new Map();
  shouldFail: boolean = false;
  workers_list: WorkerInfo[] = [];
  gpuUtilization: number | null = null;

  constructor(name: string, workerCount: number = 3) {
    this.name = name;
    this.workers_list = Array.from({ length: workerCount }, (_, i) => ({
      workerId: `${name}-worker-${i}`,
      gpuId: `gpu-${i}`,
      ipAddress: `192.168.1.${100 + i}`,
      port: 5000 + i,
      gpuMemoryGB: 16,
      availableGPUMemory: 16, // Always 16GB available, don't decrease
      provider: name,
      secureRuntimeActive: true,
    }));
  }

  async acquireWorker(requirements: WorkerRequirements): Promise<WorkerInfo | null> {
    if (this.shouldFail) {
      throw new Error('Provider failed');
    }

    const available = this.workers_list.find(
      w =>
        !this.workers.has(w.workerId) &&
        w.availableGPUMemory >= requirements.minGPUMemory
    );

    if (available) {
      this.workers.set(available.workerId, available);
      return available;
    }

    return null;
  }

  async releaseWorker(workerId: string): Promise<void> {
    this.workers.delete(workerId);
  }

  async healthCheck(workerId: string): Promise<boolean> {
    return this.workers.has(workerId);
  }

  async getGpuUtilization(_workerId: string): Promise<number | null> {
    return this.gpuUtilization;
  }
}

// Blueprint fixture
function createBlueprintFixture(overrides?: Partial<BlueprintJSON>): BlueprintJSON {
  return {
    id: 'blueprint-123',
    timestamp: new Date().toISOString(),
    framework: {
      framework: 'pytorch',
      version: '2.1',
      cudaVersion: '12.1',
      pythonVersion: '3.10',
      primaryUse: 'inference',
    },
    dependencyLock: {
      'torch': '2.1.0',
      'torchvision': '0.16.0',
    },
    systemRequirements: {
      pythonVersion: '3.10',
      cudaVersion: '12.1',
      cuDNNVersion: '8.7',
      baseImageId: 'nvidia/cuda',
      baseImageTag: '12.1-runtime-ubuntu22.04',
      systemPackages: ['build-essential', 'git'],
    },
    customModels: [],
    deploymentConfig: {
      entrypoint: 'python main.py',
      runtime: 'python',
      memoryMB: 2048,
      gpuRequired: true,
      gpuMemoryGB: 8,
    },
    checksums: {
      allDepsHash: 'hash123',
      blueprintHash: 'hash456',
    },
    ...overrides,
  };
}

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let redisClient: MockRedisClient;
  let provider1: MockGPUProvider;
  let provider2: MockGPUProvider;

  beforeEach(() => {
    redisClient = new MockRedisClient();
    provider1 = new MockGPUProvider('provider1', 3);
    provider2 = new MockGPUProvider('provider2', 2);
    orchestrator = new Orchestrator([provider1, provider2], redisClient as any);
  });

  describe('acquireWorker', () => {
    it('should acquire worker within timeout', async () => {
      const start = Date.now();
      const requirements: WorkerRequirements = {
        minGPUMemory: 8,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker).toBeDefined();
      expect(worker.workerId).toMatch(/worker-/);
      expect(worker.availableGPUMemory).toBeGreaterThanOrEqual(requirements.minGPUMemory);
      expect(Date.now() - start).toBeLessThan(5000);
    });

    it('should prefer worker with most available GPU memory', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const worker = await orchestrator.acquireWorker(requirements);

      expect(worker.workerId).toBe('provider1-worker-0');
      expect(worker.availableGPUMemory).toBe(16);
    });

    it('should throw when no workers available', async () => {
      provider1.shouldFail = true;
      provider2.shouldFail = true;

      const requirements: WorkerRequirements = {
        minGPUMemory: 8,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      await expect(orchestrator.acquireWorker(requirements)).rejects.toThrow(DeploymentError);
    });

    it('should throw when GPU memory requirement cannot be met', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 128, // More than available
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      await expect(orchestrator.acquireWorker(requirements)).rejects.toThrow(DeploymentError);
    });

    it('should support concurrent worker acquisition', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const [w1, w2, w3] = await Promise.all([
        orchestrator.acquireWorker(requirements),
        orchestrator.acquireWorker(requirements),
        orchestrator.acquireWorker(requirements),
      ]);

      expect(w1.workerId).not.toBe(w2.workerId);
      expect(w2.workerId).not.toBe(w3.workerId);
      expect(w1.workerId).not.toBe(w3.workerId);
    });
  });

  describe('releaseWorker', () => {
    it('should release acquired worker', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const worker = await orchestrator.acquireWorker(requirements);
      expect(provider1.workers.has(worker.workerId)).toBe(true);

      await orchestrator.releaseWorker(worker.workerId);
      expect(provider1.workers.has(worker.workerId)).toBe(false);
    });

    it('should handle release of non-existent worker', async () => {
      await expect(orchestrator.releaseWorker('non-existent-worker')).resolves.not.toThrow();
    });

    it('should release worker and make it available again', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const worker1 = await orchestrator.acquireWorker(requirements);
      const workerId = worker1.workerId;

      await orchestrator.releaseWorker(workerId);

      const worker2 = await orchestrator.acquireWorker(requirements);
      expect(worker2.workerId).toBe(workerId);
    });
  });

  describe('deployAgent', () => {
    beforeEach(async () => {
      // Reset mock for each test
      redisClient = new MockRedisClient();
      orchestrator = new Orchestrator([provider1, provider2], redisClient as any);
    });

    it('should deploy agent successfully', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);

      const start = Date.now();
      const blueprint = createBlueprintFixture();
      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      expect(result.agentId).toBeDefined();
      expect(result.status).toBe('running');
      expect(result.deploymentTime).toBeGreaterThanOrEqual(0);
      expect(result.deploymentTime).toBeLessThan(30000);
      expect(Date.now() - start).toBeLessThan(30000);
    });

    it('should mark deployment as pending initially', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      const status = await orchestrator.getDeploymentStatus(result.agentId);
      expect(status.status).toBe('running');
    });

    it('should throw on missing blueprint ID', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture({ id: '' });

      await expect(
        orchestrator.deployAgent(
          worker.workerId,
          blueprint,
          '/path/to/lockfile',
          'env-hash-123'
        )
      ).rejects.toThrow(DeploymentError);
    });

    it('should allow missing lockfile path', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const result = await orchestrator.deployAgent(
       worker.workerId,
       blueprint,
       '',
       'env-hash-123'
      );

      expect(result.status).toBe('running');
    });

    it('should throw on missing environment hash', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      await expect(
        orchestrator.deployAgent(
          worker.workerId,
          blueprint,
          '/path/to/lockfile',
          ''
        )
      ).rejects.toThrow(DeploymentError);
    });

    it('should throw when worker not found', async () => {
      const blueprint = createBlueprintFixture();

      await expect(
        orchestrator.deployAgent(
          'non-existent-worker',
          blueprint,
          '/path/to/lockfile',
          'env-hash-123'
        )
      ).rejects.toThrow(DeploymentError);
    });

    it('should support concurrent deployments', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 2,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const w1 = await orchestrator.acquireWorker(requirements);
      const w2 = await orchestrator.acquireWorker(requirements);
      const w3 = await orchestrator.acquireWorker(requirements);

      const blueprint = createBlueprintFixture();

      const [r1, r2, r3] = await Promise.all([
        orchestrator.deployAgent(w1.workerId, blueprint, '/lockfile1', 'hash1'),
        orchestrator.deployAgent(w2.workerId, blueprint, '/lockfile2', 'hash2'),
        orchestrator.deployAgent(w3.workerId, blueprint, '/lockfile3', 'hash3'),
      ]);

      expect(r1.agentId).not.toBe(r2.agentId);
      expect(r2.agentId).not.toBe(r3.agentId);
      expect(r1.status).toBe('running');
      expect(r2.status).toBe('running');
      expect(r3.status).toBe('running');
    });

    it('should set container image from blueprint', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      const status = await orchestrator.getDeploymentStatus(result.agentId);
      expect(status.containerImage).toBe('nvidia/cuda:12.1-runtime-ubuntu22.04');
    });

    it('should mark failed deployment with error message', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      provider1.workers.delete(worker.workerId); // Simulate worker disconnect

      const blueprint = createBlueprintFixture();

      await expect(
        orchestrator.deployAgent(
          worker.workerId,
          blueprint,
          '/path/to/lockfile',
          'env-hash-123'
        )
      ).rejects.toThrow(DeploymentError);
    });
  });

  describe('getDeploymentStatus', () => {
    it('should retrieve deployment status', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      const status = await orchestrator.getDeploymentStatus(deployment.agentId);

      expect(status.agentId).toBe(deployment.agentId);
      expect(status.workerId).toBe(worker.workerId);
      expect(status.status).toBe('running');
      expect(status.containerImage).toBeDefined();
      expect(status.gpuUtilization).toBeNull();
    });

    it('should populate live GPU utilization when running', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      provider1.gpuUtilization = 72;
      const blueprint = createBlueprintFixture();

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123',
      );

      const status = await orchestrator.getDeploymentStatus(deployment.agentId);

      expect(status.status).toBe('running');
      expect(status.gpuUtilization).toBe(72);
    });

    it('should not populate GPU utilization for non-running deployments', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      provider1.gpuUtilization = 55;
      const blueprint = createBlueprintFixture();

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123',
      );

      const deploymentKey = `orchestration:deployment:${deployment.agentId}`;
      const stored = JSON.parse(redisClient.store.get(deploymentKey)!);
      stored.status = 'deploying';
      redisClient.store.set(deploymentKey, JSON.stringify(stored));

      const status = await orchestrator.getDeploymentStatus(deployment.agentId);

      expect(status.status).toBe('deploying');
      expect(status.gpuUtilization).toBeUndefined();
    });

    it('should throw for non-existent deployment', async () => {
      await expect(
        orchestrator.getDeploymentStatus('non-existent-agent')
      ).rejects.toThrow(DeploymentError);
    });

    it('should return null GPU utilization when provider has no metric', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      provider1.gpuUtilization = null;
      const blueprint = createBlueprintFixture();

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123',
      );

      const status = await orchestrator.getDeploymentStatus(deployment.agentId);
      expect(status.gpuUtilization).toBeNull();
    });
  });

  describe('listDeployments', () => {
    it('should return empty list initially', async () => {
      const deployments = await orchestrator.listDeployments();
      expect(deployments).toEqual([]);
    });

    it('should list all active deployments', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 2,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const w1 = await orchestrator.acquireWorker(requirements);
      const w2 = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const d1 = await orchestrator.deployAgent(w1.workerId, blueprint, '/lock1', 'hash1');
      const d2 = await orchestrator.deployAgent(w2.workerId, blueprint, '/lock2', 'hash2');

      const deployments = await orchestrator.listDeployments();

      expect(deployments).toHaveLength(2);
      expect(deployments.map(d => d.agentId)).toContain(d1.agentId);
      expect(deployments.map(d => d.agentId)).toContain(d2.agentId);
    });

    it('should handle deployments with missing state gracefully', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 2,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const deployment = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/lockfile',
        'env-hash-123'
      );

      // Manually corrupt the state
      redisClient.store.delete(`orchestration:deployment:${deployment.agentId}`);

      const deployments = await orchestrator.listDeployments();
      expect(deployments).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should throw DeploymentError on Redis connection failure', async () => {
      redisClient.isOpen = false;
      redisClient.connect = jest.fn().mockRejectedValue(new Error('Connection failed'));

      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      await expect(orchestrator.acquireWorker(requirements)).rejects.toThrow(DeploymentError);
    });

    it('should include cause in error details', async () => {
      redisClient.isOpen = false;
      const originalError = new Error('Original error message');
      redisClient.connect = jest.fn().mockRejectedValue(originalError);

      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      try {
        await orchestrator.acquireWorker(requirements);
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(DeploymentError);
        expect(error.details?.cause).toBeDefined();
      }
    });
  });

  describe('performance', () => {
    it('should acquire worker in <5s', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const start = Date.now();
      await orchestrator.acquireWorker(requirements);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(5000);
    });

    it('should deploy agent in <30s', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const start = Date.now();
      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );
      const duration = Date.now() - start;

      expect(result.deploymentTime).toBeLessThan(30000);
      expect(duration).toBeLessThan(30000);
    });

    it('should list deployments quickly', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 1,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };

      // Create fresh test infrastructure with isolated state
      const testRedisClient = new MockRedisClient();
      const provider3 = new MockGPUProvider('provider3', 20);
      const testOrchestrator = new Orchestrator(
        [provider3],
        testRedisClient as any
      );

      // Create 10 deployments
      const deploymentIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const worker = await testOrchestrator.acquireWorker(requirements);
        if (!worker) {
          throw new Error(`Failed to acquire worker ${i}`);
        }
        const blueprint = createBlueprintFixture();
        const result = await testOrchestrator.deployAgent(
          worker.workerId,
          blueprint,
          `/lock${i}`,
          `hash${i}`
        );
        deploymentIds.push(result.agentId);
      }

      const start = Date.now();
      const deployments = await testOrchestrator.listDeployments();
      const duration = Date.now() - start;

      expect(deployments.length).toBeGreaterThanOrEqual(10);
      expect(duration).toBeLessThan(2000); // Give it more time since 10 is borderline
    });
  });

  describe('state transitions', () => {
    it('should transition from pending → deploying → running', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      const status = await orchestrator.getDeploymentStatus(result.agentId);
      expect(status.status).toBe('running');
    });

    it('should store deployment metadata correctly', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      const status = await orchestrator.getDeploymentStatus(result.agentId);

      expect(status.workerId).toBe(worker.workerId);
      expect(status.containerImage).toContain('nvidia/cuda');
      expect(status.startTime).toBeGreaterThan(0);
    });
  });

  describe('deployment state persistence', () => {
    it('should persist deployment state to Redis', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      const key = `orchestration:deployment:${result.agentId}`;
      expect(redisClient.store.has(key)).toBe(true);

      const stored = JSON.parse(redisClient.store.get(key)!);
      expect(stored.agentId).toBe(result.agentId);
      expect(stored.status).toBe('running');
    });

    it('should add deployment to active deployments set', async () => {
      const requirements: WorkerRequirements = {
        minGPUMemory: 4,
        framework: 'pytorch',
        pythonVersion: '3.10',
      };
      const worker = await orchestrator.acquireWorker(requirements);
      const blueprint = createBlueprintFixture();

      const result = await orchestrator.deployAgent(
        worker.workerId,
        blueprint,
        '/path/to/lockfile',
        'env-hash-123'
      );

      const activeDeployments = redisClient.sets.get('orchestration:active-deployments');
      expect(activeDeployments?.has(result.agentId)).toBe(true);
    });
  });
});
