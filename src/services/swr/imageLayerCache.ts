import crypto from 'crypto';
import { logger } from '../../utils/logger';
import type { BlueprintJSON } from '../../types/blueprint.types';
import { RedisWeightRegistry } from './redisClient';

const CACHE_KEY_PREFIX = 'image-layer:';

export interface ImageLayerCacheEntry {
  layerKey: string;
  imageRef: string;
  framework: string;
  frameworkVersion: string;
  cachedAt: number;
}

/**
 * S3-backed image layer cache (KRI-19).
 * sha256(framework + deps) → Redis lookup for pre-built Modal image refs.
 * Repeat deploys skip pip_install when cache hits (~30s → ~2s).
 */
export class ImageLayerCache {
  private readonly registry: RedisWeightRegistry;

  constructor(registry?: RedisWeightRegistry) {
    this.registry = registry ?? new RedisWeightRegistry();
  }

  computeLayerKey(blueprint: BlueprintJSON): string {
    const payload = JSON.stringify({
      framework: blueprint.framework?.framework,
      version: blueprint.framework?.version,
      pythonVersion: blueprint.framework?.pythonVersion,
      deps: blueprint.dependencyLock ?? {},
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  cacheKey(layerKey: string): string {
    return `${CACHE_KEY_PREFIX}${layerKey}`;
  }

  async lookup(blueprint: BlueprintJSON): Promise<string | null> {
    const layerKey = this.computeLayerKey(blueprint);
    const start = Date.now();
    const imageRef = await this.registry.getWeightCache(this.cacheKey(layerKey));
    if (imageRef) {
      logger.info(
        `✓ Image layer cache hit: ${blueprint.framework?.framework}:${blueprint.framework?.version} (${Date.now() - start}ms)`,
      );
    }
    return imageRef;
  }

  async register(blueprint: BlueprintJSON, imageRef: string): Promise<void> {
    const layerKey = this.computeLayerKey(blueprint);
    await this.registry.setWeightCache(this.cacheKey(layerKey), imageRef);
    logger.info(
      `✓ Image layer cached: ${blueprint.framework?.framework}:${blueprint.framework?.version} (key=${layerKey.substring(0, 8)}...)`,
    );
  }
}
