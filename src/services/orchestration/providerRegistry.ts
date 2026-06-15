import { logger } from '../../utils/logger';
import type { GPUProvider, WorkerRequirements, WorkerInfo } from './orchestrator';

export interface ProviderQuote {
  provider: GPUProvider;
  name: string;
  pricePerHour: number;
  gpuType: string;
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
   */
  async acquireWorker(
    requirements: WorkerRequirements,
    preferredProvider?: string,
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
    for (const quote of quotes) {
      const worker = await quote.provider.acquireWorker(requirements);
      if (worker) {
        logger.info(
          `✓ Provider registry selected ${quote.name} (${quote.gpuType}, $${quote.pricePerHour}/hr) in ${Date.now() - start}ms`,
        );
        return worker;
      }
    }

    return null;
  }

  async rankProviders(requirements: WorkerRequirements): Promise<ProviderQuote[]> {
    const quotes: ProviderQuote[] = [];

    for (const provider of this.providers) {
      const price = await this.estimatePrice(provider, requirements.minGPUMemory);
      quotes.push({
        provider,
        name: provider.name,
        pricePerHour: price,
        gpuType: this.gpuTypeForMemory(requirements.minGPUMemory),
      });
    }

    return quotes.sort((a, b) => a.pricePerHour - b.pricePerHour);
  }

  private async estimatePrice(provider: GPUProvider, minMemoryGB: number): Promise<number> {
    const gpuType = this.gpuTypeForMemory(minMemoryGB);
    if ('getPrice' in provider && typeof (provider as { getPrice?: unknown }).getPrice === 'function') {
      try {
        const price = await (provider as GPUProvider & { getPrice: (g: string) => Promise<number> }).getPrice(gpuType);
        return price;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    }
    return 999;
  }

  private gpuTypeForMemory(minMemoryGB: number): string {
    if (minMemoryGB <= 16) return 'T4';
    if (minMemoryGB <= 24) return 'L4';
    if (minMemoryGB <= 40) return 'A100';
    return 'H100';
  }
}
