import { createClient } from 'redis';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const DEFAULT_TTL_SECONDS = 2_592_000; // 30 days
const DEFAULT_KEY_PREFIX = 'weight:';
const DEFAULT_ALL_WEIGHTS_KEY = 'weights:all';

export interface CachedWeight {
  modelHash: string;
  framework: string;
  sizeGB: number;
  storagePath: string;
  mountPoint: string;
  lastAccessed: number;
  cacheHits: number;
  ttlSeconds: number;
}

export interface WeightCacheStats {
  totalWeights: number;
  totalSizeGB: number;
  cacheHitRate: number;
}

interface RedisSetOptions {
  EX?: number;
}

export interface RedisWeightClient {
  isOpen: boolean;
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<unknown>;
  del(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  sAdd(key: string, member: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
}

interface RedisWeightRegistryOptions {
  url?: string;
  keyPrefix?: string;
  allWeightsKey?: string;
  defaultTtlSeconds?: number;
}

export class RedisWeightRegistry {
  private readonly client: RedisWeightClient;

  private readonly keyPrefix: string;

  private readonly allWeightsKey: string;

  private readonly defaultTtlSeconds: number;

  constructor(client?: RedisWeightClient | null, options?: RedisWeightRegistryOptions) {
    this.client = client ?? (createClient({ url: options?.url }) as unknown as RedisWeightClient);
    this.keyPrefix = options?.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.allWeightsKey = options?.allWeightsKey ?? DEFAULT_ALL_WEIGHTS_KEY;
    this.defaultTtlSeconds = options?.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async lookup(modelHash: string): Promise<CachedWeight | null> {
    const start = Date.now();
    const key = this.key(modelHash);

    try {
      await this.ensureConnected();
      const payload = await this.client.get(key);

      if (!payload) {
        logger.info(`Redis lookup miss: ${modelHash} (${Date.now() - start}ms)`);
        return null;
      }

      const cached = this.parseCachedWeight(payload, key);
      const nextWeight: CachedWeight = {
        ...cached,
        lastAccessed: Date.now(),
        cacheHits: cached.cacheHits + 1,
      };

      const ttlSeconds = await this.client.ttl(key);
      const effectiveTtl = ttlSeconds > 0 ? ttlSeconds : this.defaultTtlSeconds;
      await this.client.set(key, JSON.stringify(nextWeight), { EX: effectiveTtl });

      logger.info(`Redis lookup hit: ${modelHash} (${Date.now() - start}ms)`);
      return nextWeight;
    } catch (error: unknown) {
      throw this.toDeploymentError('Redis lookup failed', { modelHash, key }, error);
    }
  }

  async register(weight: CachedWeight): Promise<void> {
    const start = Date.now();
    const key = this.key(weight.modelHash);

    try {
      await this.ensureConnected();

      const normalized: CachedWeight = {
        ...weight,
        ttlSeconds: weight.ttlSeconds || this.defaultTtlSeconds,
        lastAccessed: weight.lastAccessed || Date.now(),
        cacheHits: Math.max(weight.cacheHits + 1, 1),
      };

      await this.client.set(key, JSON.stringify(normalized), { EX: normalized.ttlSeconds });
      await this.client.sAdd(this.allWeightsKey, weight.modelHash);

      logger.info(`Redis register complete: ${weight.modelHash} (${Date.now() - start}ms)`);
    } catch (error: unknown) {
      throw this.toDeploymentError('Redis register failed', { modelHash: weight.modelHash, key }, error);
    }
  }

  async stats(): Promise<WeightCacheStats> {
    const start = Date.now();

    try {
      await this.ensureConnected();
      const hashes = await this.client.sMembers(this.allWeightsKey);
      const records = await this.loadWeights(hashes);

      const totalWeights = records.length;
      const totalSizeGB = records.reduce((sum, item) => sum + item.sizeGB, 0);
      const totalHits = records.reduce((sum, item) => sum + item.cacheHits, 0);
      const cacheHitRate = totalWeights === 0 ? 0 : totalHits / totalWeights;

      logger.info(`Redis stats complete (${Date.now() - start}ms)`);

      return {
        totalWeights,
        totalSizeGB,
        cacheHitRate,
      };
    } catch (error: unknown) {
      throw this.toDeploymentError('Redis stats failed', {}, error);
    }
  }

  async evictLRU(maxSizeGB: number): Promise<void> {
    const start = Date.now();

    try {
      await this.ensureConnected();
      const hashes = await this.client.sMembers(this.allWeightsKey);
      const records = await this.loadWeights(hashes);

      let totalSizeGB = records.reduce((sum, item) => sum + item.sizeGB, 0);
      const sorted = [...records].sort((a, b) => a.lastAccessed - b.lastAccessed);

      for (const weight of sorted) {
        if (totalSizeGB <= maxSizeGB) {
          break;
        }

        await this.client.del(this.key(weight.modelHash));
        await this.client.sRem(this.allWeightsKey, weight.modelHash);
        totalSizeGB -= weight.sizeGB;

        logger.info(`Evicted weight ${weight.modelHash} (${weight.sizeGB}GB)`);
      }

      logger.info(`Redis LRU eviction complete (${Date.now() - start}ms)`);
    } catch (error: unknown) {
      throw this.toDeploymentError('Redis LRU eviction failed', { maxSizeGB }, error);
    }
  }

  private key(modelHash: string): string {
    return `${this.keyPrefix}${modelHash}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) {
      return;
    }

    try {
      await this.client.connect();
    } catch (error: unknown) {
      throw this.toDeploymentError('Redis connection failed', {}, error);
    }
  }

  private async loadWeights(hashes: string[]): Promise<CachedWeight[]> {
    const results = await Promise.all(
      hashes.map(async hash => {
        const payload = await this.client.get(this.key(hash));
        if (!payload) {
          await this.client.sRem(this.allWeightsKey, hash);
          return null;
        }

        return this.parseCachedWeight(payload, this.key(hash));
      }),
    );

    return results.filter((record): record is CachedWeight => record !== null);
  }

  private parseCachedWeight(payload: string, key: string): CachedWeight {
    try {
      return JSON.parse(payload) as CachedWeight;
    } catch (error: unknown) {
      throw this.toDeploymentError('Redis cached weight parse failed', { key }, error);
    }
  }

  private toDeploymentError(
    message: string,
    details: Record<string, unknown>,
    cause: unknown,
  ): DeploymentError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new DeploymentError(message, { ...details, cause: causeMessage });
  }
}

export default RedisWeightRegistry;
