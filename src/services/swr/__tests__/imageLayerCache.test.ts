import { ImageLayerCache } from '../imageLayerCache';
import type { BlueprintJSON } from '../../../types/blueprint.types';
import { RedisWeightRegistry } from '../redisClient';

const mockBlueprint: BlueprintJSON = {
  id: 'bp_test',
  timestamp: new Date().toISOString(),
  framework: {
    framework: 'pytorch',
    version: '2.1.0',
    cudaVersion: '12.1',
    pythonVersion: '3.11',
    primaryUse: 'inference',
  },
  dependencyLock: { torch: '2.1.0' },
  systemRequirements: {
    pythonVersion: '3.11',
    cudaVersion: '12.1',
    cuDNNVersion: '8.6',
    baseImageId: 'python',
    baseImageTag: '3.11-slim',
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

describe('ImageLayerCache', () => {
  it('should compute deterministic layer key from blueprint', () => {
    const cache = new ImageLayerCache();
    const key1 = cache.computeLayerKey(mockBlueprint);
    const key2 = cache.computeLayerKey(mockBlueprint);
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);
  });

  it('should register and lookup image ref', async () => {
    const store = new Map<string, string>();
    const mockRegistry = {
      getWeightCache: jest.fn(async (key: string) => store.get(key) ?? null),
      setWeightCache: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    } as unknown as RedisWeightRegistry;

    const cache = new ImageLayerCache(mockRegistry);
    const miss = await cache.lookup(mockBlueprint);
    expect(miss).toBeNull();

    await cache.register(mockBlueprint, 'modal-image-ref-abc');
    const hit = await cache.lookup(mockBlueprint);
    expect(hit).toBe('modal-image-ref-abc');
  });
});
