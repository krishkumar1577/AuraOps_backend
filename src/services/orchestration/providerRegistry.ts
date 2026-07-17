import { logger } from '../../utils/logger';
import type { GPUProvider, WorkerRequirements, WorkerInfo } from './orchestrator';
import { PROVIDER_DEFAULT_HOURLY_PRICES } from './deployProviderFallback';
import { mapPool } from './parallel';

/** How the hourly quote was obtained for ranking. */
export type PriceSource = 'live-list' | 'getPrice' | 'default-map';

export interface ProviderQuote {
  provider: GPUProvider;
  name: string;
  pricePerHour: number;
  gpuType: string;
  priceSource: PriceSource;
}

interface AvailableGpuLike {
  gpuType: string;
  memoryGB: number;
  available?: boolean;
  pricePerHour?: number;
}

/**
 * KRI-21: Pluggable provider registry — orchestrator picks cheapest available GPU.
 */
export class ProviderRegistry {
  private readonly providers: GPUProvider[];

  constructor(providers: GPUProvider[]) {
    this.providers = providers;
  }

  list(): GPUProvider[] {
    return [...this.providers];
  }

  getByName(name: string): GPUProvider | undefined {
    return this.providers.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /**
   * Acquire worker from the named provider, or cheapest available when provider is 'auto'.
   * Ranking quotes run in parallel. Acquisition tries providers cheapest-first sequentially
   * by default; set race=true to race top providers in parallel (faster, may briefly over-acquire).
   */
  async acquireWorker(
    requirements: WorkerRequirements,
    preferredProvider?: string,
    options?: { race?: boolean; raceTopN?: number },
  ): Promise<WorkerInfo | null> {
    const start = Date.now();

    if (preferredProvider && preferredProvider !== 'auto') {
      const provider = this.getByName(preferredProvider);
      if (!provider) {
        logger.warn(`Provider not found: ${preferredProvider}`);
        return null;
      }
      return provider.acquireWorker(requirements);
    }

    const quotes = await this.rankProviders(requirements);

    if (options?.race) {
      const topN = Math.max(1, Math.min(options.raceTopN ?? 3, quotes.length));
      const contenders = quotes.slice(0, topN);
      // Fire top-N acquires in parallel; keep cheapest success (contenders already sorted).
      const settled = await Promise.all(
        contenders.map(async (quote) => {
          try {
            const worker = await quote.provider.acquireWorker(requirements);
            return worker ? { quote, worker } : null;
          } catch {
            return null;
          }
        }),
      );

      const successes = settled.filter(
        (s): s is { quote: ProviderQuote; worker: WorkerInfo } => s != null,
      );
      if (successes.length === 0) {
        return null;
      }

      const winner = successes[0];
      await Promise.all(
        successes.slice(1).map(async ({ quote, worker }) => {
          try {
            await quote.provider.releaseWorker(worker.workerId);
          } catch {
            // best-effort release of parallel over-acquire
          }
        }),
      );

      logger.info(
        `✓ Provider registry parallel-acquire ${winner.quote.name} (${winner.quote.gpuType}, $${winner.quote.pricePerHour}/hr) in ${Date.now() - start}ms`,
      );
      return winner.worker;
    }

    for (const quote of quotes) {
      const worker = await quote.provider.acquireWorker(requirements);
      if (worker) {
        logger.info(
          `✓ Provider registry selected ${quote.name} (${quote.gpuType}, $${quote.pricePerHour}/hr, source=${quote.priceSource}) in ${Date.now() - start}ms`,
        );
        return worker;
      }
    }

    return null;
  }

  async rankProviders(requirements: WorkerRequirements): Promise<ProviderQuote[]> {
    // Parallel price discovery across all providers (was sequential).
    const quotes = await mapPool(this.providers, this.providers.length, async (provider) => {
      const quote = await this.estimateQuote(provider, requirements.minGPUMemory);
      logger.info(
        `Provider quote: ${provider.name} ${quote.gpuType} $${quote.pricePerHour}/hr source=${quote.priceSource}`,
      );
      return {
        provider,
        name: provider.name,
        pricePerHour: quote.pricePerHour,
        gpuType: quote.gpuType,
        priceSource: quote.priceSource,
      } satisfies ProviderQuote;
    });

    return quotes.sort((a, b) => a.pricePerHour - b.pricePerHour);
  }

  /**
   * Prefer live listAvailable() cheapest matching memory; else getPrice(mapped type); else default map.
   */
  private async estimateQuote(
    provider: GPUProvider,
    minMemoryGB: number,
  ): Promise<{ pricePerHour: number; gpuType: string; priceSource: PriceSource }> {
    const mappedGpuType = this.gpuTypeForMemory(minMemoryGB);

    const listFn = (provider as GPUProvider & {
      listAvailable?: () => Promise<AvailableGpuLike[]>;
    }).listAvailable;

    if (typeof listFn === 'function') {
      try {
        const available = await listFn.call(provider);
        const matching = available
          .filter(
            (gpu) =>
              gpu.available !== false &&
              gpu.memoryGB >= minMemoryGB &&
              typeof gpu.pricePerHour === 'number' &&
              gpu.pricePerHour > 0,
          )
          .sort((a, b) => (a.pricePerHour ?? 0) - (b.pricePerHour ?? 0));

        if (matching.length > 0) {
          const best = matching[0];
          return {
            pricePerHour: best.pricePerHour as number,
            gpuType: best.gpuType,
            priceSource: 'live-list',
          };
        }
      } catch (error) {
        logger.warn(
          `listAvailable failed for ${provider.name}, falling back to getPrice: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if ('getPrice' in provider && typeof (provider as { getPrice?: unknown }).getPrice === 'function') {
      try {
        const price = await (
          provider as GPUProvider & { getPrice: (g: string) => Promise<number> }
        ).getPrice(mappedGpuType);
        if (price > 0) {
          return {
            pricePerHour: price,
            gpuType: mappedGpuType,
            priceSource: 'getPrice',
          };
        }
      } catch {
        return {
          pricePerHour: Number.POSITIVE_INFINITY,
          gpuType: mappedGpuType,
          priceSource: 'getPrice',
        };
      }
    }

    const defaultPrice = PROVIDER_DEFAULT_HOURLY_PRICES[provider.name.toLowerCase()];
    return {
      pricePerHour: defaultPrice ?? 999,
      gpuType: mappedGpuType,
      priceSource: 'default-map',
    };
  }

  private gpuTypeForMemory(minMemoryGB: number): string {
    if (minMemoryGB <= 8) return 'T4';
    if (minMemoryGB <= 16) return 'T4';
    if (minMemoryGB <= 24) return 'A10G';
    if (minMemoryGB <= 40) return 'A100';
    return 'H100';
  }
}
