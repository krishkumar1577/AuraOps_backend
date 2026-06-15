import { ProviderRegistry } from '../providerRegistry';
import type { GPUProvider, WorkerInfo, WorkerRequirements } from '../orchestrator';

class CheapProvider implements GPUProvider {
  name = 'CheapCloud';

  async acquireWorker(_req: WorkerRequirements): Promise<WorkerInfo | null> {
    return {
      workerId: 'cheap-1',
      gpuId: 'gpu-0',
      ipAddress: '10.0.0.1',
      port: 8000,
      gpuMemoryGB: 24,
      availableGPUMemory: 24,
      provider: this.name,
      secureRuntimeActive: false,
    };
  }

  async releaseWorker(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
  async getGpuUtilization(): Promise<number | null> { return null; }
  async getPrice(): Promise<number> { return 0.5; }
}

class ExpensiveProvider implements GPUProvider {
  name = 'AWS';

  async acquireWorker(): Promise<WorkerInfo | null> { return null; }
  async releaseWorker(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
  async getGpuUtilization(): Promise<number | null> { return null; }
  async getPrice(): Promise<number> { return 4.5; }
}

class AzureProvider implements GPUProvider {
  name = 'Azure';

  async acquireWorker(_req: WorkerRequirements): Promise<WorkerInfo | null> {
    return {
      workerId: 'azure-1',
      gpuId: 'gpu-0',
      ipAddress: '10.0.0.2',
      port: 443,
      gpuMemoryGB: 24,
      availableGPUMemory: 24,
      provider: this.name,
      secureRuntimeActive: false,
    };
  }

  async releaseWorker(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
  async getGpuUtilization(): Promise<number | null> { return null; }
  async getPrice(): Promise<number> { return 2.5; }
}

class ModalProviderMock implements GPUProvider {
  name = 'Modal';

  async acquireWorker(): Promise<WorkerInfo | null> { return null; }
  async releaseWorker(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
  async getGpuUtilization(): Promise<number | null> { return null; }
  async getPrice(): Promise<number> { return 3.5; }
}

describe('ProviderRegistry', () => {
  const requirements: WorkerRequirements = {
    minGPUMemory: 16,
    framework: 'pytorch',
    pythonVersion: '3.11',
  };

  it('should rank providers by price', async () => {
    const registry = new ProviderRegistry([new ExpensiveProvider(), new CheapProvider()]);
    const ranked = await registry.rankProviders(requirements);
    expect(ranked[0].name).toBe('CheapCloud');
    expect(ranked[0].pricePerHour).toBeLessThan(ranked[1].pricePerHour);
  });

  it('should acquire from cheapest available provider', async () => {
    const registry = new ProviderRegistry([new ExpensiveProvider(), new CheapProvider()]);
    const worker = await registry.acquireWorker(requirements);
    expect(worker?.provider).toBe('CheapCloud');
  });

  it('should acquire from named provider', async () => {
    const registry = new ProviderRegistry([new ExpensiveProvider(), new CheapProvider()]);
    const worker = await registry.acquireWorker(requirements, 'AWS');
    expect(worker).toBeNull();
  });

  it('should rank Azure below Modal and above AWS by cost', async () => {
    const registry = new ProviderRegistry([
      new ExpensiveProvider(),
      new ModalProviderMock(),
      new AzureProvider(),
    ]);
    const ranked = await registry.rankProviders(requirements);
    const names = ranked.map((q) => q.name);
    expect(names.indexOf('Azure')).toBeLessThan(names.indexOf('Modal'));
    expect(names.indexOf('Modal')).toBeLessThan(names.indexOf('AWS'));
    expect(ranked[0].name).toBe('Azure');
  });

  it('should acquire from cheapest Azure when auto-selecting', async () => {
    const registry = new ProviderRegistry([
      new ExpensiveProvider(),
      new ModalProviderMock(),
      new AzureProvider(),
    ]);
    const worker = await registry.acquireWorker(requirements, 'auto');
    expect(worker?.provider).toBe('Azure');
  });
});
