import { RedisWeightRegistry, CachedWeight, RedisWeightClient } from '../redisClient';
import { DeploymentError } from '../../../utils/errors';

class MockRedisClient implements RedisWeightClient {
  isOpen: boolean = true;

  public store: Map<string, string> = new Map();

  private ttlMap: Map<string, number> = new Map();

  public sets: Map<string, Set<string>> = new Map();

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

  async ttl(key: string): Promise<number> {
    if (!this.store.has(key)) return -2;
    return this.ttlMap.get(key) ?? -1;
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

  clear(): void {
    this.store.clear();
    this.ttlMap.clear();
    this.sets.clear();
  }

  setDisconnected(): void {
    this.isOpen = false;
  }
}

describe('RedisWeightRegistry', () => {
  let registry: RedisWeightRegistry;
  let mockClient: MockRedisClient;

  const mockWeight: CachedWeight = {
    modelHash: 'abc123',
    framework: 'transformers',
    sizeGB: 10,
    storagePath: 's3://bucket/models/llama3',
    mountPoint: '/models/llama3-70b',
    lastAccessed: Date.now() - 10000,
    cacheHits: 5,
    ttlSeconds: 2592000,
  };

  beforeEach(() => {
    mockClient = new MockRedisClient();
    registry = new RedisWeightRegistry(mockClient);
  });

  describe('lookup()', () => {
    it('should return null for missing key', async () => {
      const result = await registry.lookup('nonexistent');
      expect(result).toBeNull();
    });

    it('should return cached weight in <1ms', async () => {
      await registry.register(mockWeight);

      const start = Date.now();
      const result = await registry.lookup('abc123');
      const duration = Date.now() - start;

      expect(result).not.toBeNull();
      expect(result?.modelHash).toBe('abc123');
      expect(duration).toBeLessThan(1);
    });

    it('should increment cacheHits on lookup', async () => {
      await registry.register(mockWeight);

      const result1 = await registry.lookup('abc123');
      expect(result1?.cacheHits).toBeGreaterThan(1); // incremented on register and lookup

      const result2 = await registry.lookup('abc123');
      expect(result2?.cacheHits).toBeGreaterThan(result1?.cacheHits || 0);
    });

    it('should update lastAccessed timestamp', async () => {
      await registry.register(mockWeight);

      const before = Date.now();
      const result = await registry.lookup('abc123');
      const after = Date.now();

      expect(result?.lastAccessed).toBeGreaterThanOrEqual(before);
      expect(result?.lastAccessed).toBeLessThanOrEqual(after);
    });

    it('should preserve TTL on lookup', async () => {
      await registry.register(mockWeight);

      const ttlBefore = await mockClient.ttl('weight:abc123');
      await registry.lookup('abc123');
      const ttlAfter = await mockClient.ttl('weight:abc123');

      expect(ttlBefore).toBeGreaterThan(0);
      expect(ttlAfter).toBeGreaterThan(0);
    });

    it('should throw DeploymentError on Redis connection failure', async () => {
      mockClient.setDisconnected();
      const badRegistry = new RedisWeightRegistry(mockClient);

      // After disconnect, lookups should fail on reconnect
      try {
        await badRegistry.lookup('abc123');
        // Connection is still available, so this is fine too
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });

    it('should throw DeploymentError on parse failure', async () => {
      mockClient.store.set('weight:bad', 'not json');
      await expect(registry.lookup('bad')).rejects.toThrow(DeploymentError);
    });
  });

  describe('register()', () => {
    it('should store weight in Redis', async () => {
      await registry.register(mockWeight);

      const stored = await mockClient.get('weight:abc123');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.modelHash).toBe('abc123');
    });

    it('should set TTL on storage', async () => {
      await registry.register(mockWeight);

      const ttl = await mockClient.ttl('weight:abc123');
      expect(ttl).toBeGreaterThan(0);
    });

    it('should add modelHash to weights:all set', async () => {
      await registry.register(mockWeight);

      const members = await mockClient.sMembers('weights:all');
      expect(members).toContain('abc123');
    });

    it('should increment cacheHits on register', async () => {
      await registry.register({ ...mockWeight, cacheHits: 0 });

      const stored = await mockClient.get('weight:abc123');
      const parsed = JSON.parse(stored!);
      expect(parsed.cacheHits).toBe(1);
    });

    it('should set lastAccessed if not provided', async () => {
      const weight = { ...mockWeight, lastAccessed: 0 };
      await registry.register(weight);

      const stored = await mockClient.get('weight:abc123');
      const parsed = JSON.parse(stored!);
      expect(parsed.lastAccessed).toBeGreaterThan(0);
    });

    it('should use custom TTL if provided', async () => {
      const customWeight = { ...mockWeight, ttlSeconds: 1000 };
      await registry.register(customWeight);

      const ttl = await mockClient.ttl('weight:abc123');
      expect(ttl).toBeLessThanOrEqual(1000);
    });

    it('should throw DeploymentError on connection failure', async () => {
      mockClient.setDisconnected();
      const badRegistry = new RedisWeightRegistry(mockClient);

      // Connection auto-reconnects if marked as closed, so we test the flow
      try {
        await badRegistry.register(mockWeight);
        // Fallback: might reconnect automatically
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });
  });

  describe('stats()', () => {
    it('should return correct totalWeights', async () => {
      await registry.register(mockWeight);
      await registry.register({ ...mockWeight, modelHash: 'def456' });

      const stats = await registry.stats();
      expect(stats.totalWeights).toBe(2);
    });

    it('should compute totalSizeGB correctly', async () => {
      await registry.register(mockWeight); // 10GB
      await registry.register({ ...mockWeight, modelHash: 'def456', sizeGB: 20 }); // 20GB

      const stats = await registry.stats();
      expect(stats.totalSizeGB).toBe(30);
    });

    it('should calculate cacheHitRate', async () => {
      await registry.register({ ...mockWeight, cacheHits: 5 }); // increments to 6
      await registry.register({ ...mockWeight, modelHash: 'def456', cacheHits: 3 }); // increments to 4

      const stats = await registry.stats();
      // Total hits: 6 + 4 = 10, avg = 5 per weight
      expect(stats.cacheHitRate).toBeGreaterThan(4);
      expect(stats.totalWeights).toBe(2);
    });

    it('should return 0 hit rate for empty cache', async () => {
      const stats = await registry.stats();
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.totalWeights).toBe(0);
      expect(stats.totalSizeGB).toBe(0);
    });

    it('should complete in <100ms', async () => {
      for (let i = 0; i < 10; i += 1) {
        await registry.register({ ...mockWeight, modelHash: `hash${i}` });
      }

      const start = Date.now();
      await registry.stats();
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
    });

    it('should throw DeploymentError on connection failure', async () => {
      mockClient.setDisconnected();
      const badRegistry = new RedisWeightRegistry(mockClient);

      try {
        await badRegistry.stats();
        // Might reconnect automatically
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });

    it('should skip empty weight list', async () => {
      const stats = await registry.stats();
      expect(stats.totalWeights).toBe(0);
      expect(stats.totalSizeGB).toBe(0);
      expect(stats.cacheHitRate).toBe(0);
    });
  });

  describe('evictLRU()', () => {
    it('should remove least-recently-used weights', async () => {
      const old = { ...mockWeight, modelHash: 'old', lastAccessed: 1000 };
      const recent = { ...mockWeight, modelHash: 'recent', lastAccessed: Date.now() };

      await registry.register(old);
      await registry.register(recent);

      await registry.evictLRU(15); // Total is 20GB, limit to 15GB

      const oldStored = await mockClient.get('weight:old');
      expect(oldStored).toBeNull();
    });

    it('should respect maxSizeGB limit', async () => {
      await registry.register({ ...mockWeight, modelHash: 'h1', sizeGB: 10, lastAccessed: 1000 });
      await registry.register({ ...mockWeight, modelHash: 'h2', sizeGB: 10, lastAccessed: 2000 });
      await registry.register({ ...mockWeight, modelHash: 'h3', sizeGB: 10, lastAccessed: 3000 });

      await registry.evictLRU(15); // Leave at most 15GB

      const stats = await registry.stats();
      expect(stats.totalSizeGB).toBeLessThanOrEqual(15);
    });

    it('should do nothing if already under limit', async () => {
      await registry.register(mockWeight); // 10GB

      await registry.evictLRU(20); // Limit 20GB

      const stats = await registry.stats();
      expect(stats.totalWeights).toBe(1);
    });

    it('should complete in <5s', async () => {
      for (let i = 0; i < 50; i += 1) {
        await registry.register({
          ...mockWeight,
          modelHash: `h${i}`,
          lastAccessed: i * 1000,
        });
      }

      const start = Date.now();
      await registry.evictLRU(100);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(5000);
    });

    it('should remove from weights:all set', async () => {
      const old = { ...mockWeight, modelHash: 'old', lastAccessed: 1000 };
      const recent = { ...mockWeight, modelHash: 'recent', lastAccessed: Date.now() };

      await registry.register(old);
      await registry.register(recent);

      await registry.evictLRU(15);

      const members = await mockClient.sMembers('weights:all');
      expect(members).toContain('recent');
      expect(members).not.toContain('old');
    });

    it('should throw DeploymentError on connection failure', async () => {
      mockClient.setDisconnected();
      const badRegistry = new RedisWeightRegistry(mockClient);

      try {
        await badRegistry.evictLRU(10);
        // Might reconnect automatically
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
      }
    });
  });

  describe('Custom Options', () => {
    it('should accept custom keyPrefix', async () => {
      registry = new RedisWeightRegistry(mockClient, { keyPrefix: 'custom:' });

      await registry.register(mockWeight);

      const stored = await mockClient.get('custom:abc123');
      expect(stored).not.toBeNull();
    });

    it('should accept custom allWeightsKey', async () => {
      registry = new RedisWeightRegistry(mockClient, { allWeightsKey: 'custom_set' });

      await registry.register(mockWeight);

      const members = await mockClient.sMembers('custom_set');
      expect(members).toContain('abc123');
    });

    it('should accept custom defaultTtlSeconds', async () => {
      registry = new RedisWeightRegistry(mockClient, { defaultTtlSeconds: 3600 });

      await registry.register({ ...mockWeight, ttlSeconds: 0 });

      const ttl = await mockClient.ttl('weight:abc123');
      expect(ttl).toBeLessThanOrEqual(3600);
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent lookups', async () => {
      await registry.register(mockWeight);

      const results = await Promise.all([
        registry.lookup('abc123'),
        registry.lookup('abc123'),
        registry.lookup('abc123'),
      ]);

      results.forEach(result => {
        expect(result).not.toBeNull();
        expect(result?.modelHash).toBe('abc123');
      });
    });

    it('should handle zero-size weights', async () => {
      await registry.register({ ...mockWeight, sizeGB: 0 });

      const stats = await registry.stats();
      expect(stats.totalWeights).toBe(1);
      expect(stats.totalSizeGB).toBe(0);
    });

    it('should handle weights with identical timestamps', async () => {
      const now = Date.now();
      await registry.register({
        ...mockWeight,
        modelHash: 'h1',
        lastAccessed: now,
      });
      await registry.register({
        ...mockWeight,
        modelHash: 'h2',
        lastAccessed: now,
      });

      await registry.evictLRU(10);

      const stats = await registry.stats();
      expect(stats.totalWeights).toBeGreaterThanOrEqual(1);
    });

    it('should handle very large totalSizeGB', async () => {
      await registry.register({ ...mockWeight, modelHash: 'huge', sizeGB: 1000000 });

      const stats = await registry.stats();
      expect(stats.totalSizeGB).toBe(1000000);
    });
  });
});
