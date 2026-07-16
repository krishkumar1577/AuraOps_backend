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

/** Provider with live listAvailable inventory (e.g. Lambda Labs). */
class LiveListProvider implements GPUProvider {
  name = 'LambdaLabs';
  listAvailableCalls = 0;

  async acquireWorker(): Promise<WorkerInfo | null> { return null; }
  async releaseWorker(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
  async getGpuUtilization(): Promise<number | null> { return null; }

  async getPrice(): Promise<number> {
    return 9.99; // should not win if listAvailable is used
  }

  async listAvailable() {
    this.listAvailableCalls += 1;
    return [
      { id: 'gpu_1x_a100:us-east', gpuType: 'A100', memoryGB: 40, available: true, pricePerHour: 1.29 },
      { id: 'gpu_1x_a10:us-west', gpuType: 'A10', memoryGB: 24, available: true, pricePerHour: 0.75 },
      { id: 'gpu_1x_h100:us-east', gpuType: 'H100', memoryGB: 80, available: true, pricePerHour: 2.49 },
    ];
  }
}

class ListOnlyFailsProvider implements GPUProvider {
  name = 'FlakyList';

  async acquireWorker(): Promise<WorkerInfo | null> { return null; }
  async releaseWorker(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
  async getGpuUtilization(): Promise<number | null> { return null; }
  async getPrice(): Promise<number> { return 1.25; }

  async listAvailable(): Promise<never> {
    throw new Error('API down');
  }
}

class NoPriceMethodsProvider implements GPUProvider {
  name = 'static-provider';

  async acquireWorker(): Promise<WorkerInfo | null> { return null; }
  async releaseWorker(): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
  async getGpuUtilization(): Promise<number | null> { return null; }
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
    expect(ranked[0].priceSource).toBe('getPrice');
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

  it('should prefer listAvailable cheapest matching memory (live-list)', async () => {
    const live = new LiveListProvider();
    const registry = new ProviderRegistry([new ExpensiveProvider(), live]);
    const ranked = await registry.rankProviders(requirements);

    expect(live.listAvailableCalls).toBe(1);
    const lambdaQuote = ranked.find((q) => q.name === 'LambdaLabs');
    expect(lambdaQuote).toBeDefined();
    expect(lambdaQuote!.priceSource).toBe('live-list');
    // Cheapest among memoryGB >= 16 is A10 at 0.75
    expect(lambdaQuote!.pricePerHour).toBe(0.75);
    expect(lambdaQuote!.gpuType).toBe('A10');
    expect(ranked[0].name).toBe('LambdaLabs');
  });

  it('should pick higher-memory cheapest when min memory excludes small GPUs', async () => {
    const live = new LiveListProvider();
    const registry = new ProviderRegistry([live]);
    const ranked = await registry.rankProviders({
      ...requirements,
      minGPUMemory: 40,
    });

    expect(ranked[0].priceSource).toBe('live-list');
    expect(ranked[0].gpuType).toBe('A100');
    expect(ranked[0].pricePerHour).toBe(1.29);
  });

  it('should fall back to getPrice when listAvailable fails', async () => {
    const flaky = new ListOnlyFailsProvider();
    const registry = new ProviderRegistry([flaky]);
    const ranked = await registry.rankProviders(requirements);

    expect(ranked[0].priceSource).toBe('getPrice');
    expect(ranked[0].pricePerHour).toBe(1.25);
  });

  it('should use default-map when provider has no pricing methods', async () => {
    const registry = new ProviderRegistry([new NoPriceMethodsProvider()]);
    const ranked = await registry.rankProviders(requirements);

    expect(ranked[0].priceSource).toBe('default-map');
    expect(ranked[0].pricePerHour).toBe(999);
  });
});
