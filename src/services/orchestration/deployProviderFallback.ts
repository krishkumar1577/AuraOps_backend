import { DeploymentError } from '../../utils/errors';

export const PROVIDER_DEFAULT_HOURLY_PRICES: Record<string, number> = {
  azure: 2.5,
  modal: 3.5,
  awsgpuprovider: 4.5,
  aws: 4.5,
};

export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return true;
  }

  if (error instanceof DeploymentError) {
    const details = error.details as Record<string, unknown> | undefined;
    const statusCode = details?.statusCode ?? details?.status;
    return statusCode === 429 || statusCode === '429';
  }

  return false;
}

export interface PersistentDeployProvider {
  name: string;
  deployPersistentApp(
    deploymentId: string,
    blueprint: unknown,
    deployConfig?: Record<string, unknown>,
  ): Promise<{ endpointUrl: string; appName: string; imageRef: string }>;
  getPrice?(gpuType: string): Promise<number>;
}

/**
 * Resolve provider try-order: explicit preference, or default Modal → Azure → AWS.
 */
export function resolvePersistentProviderOrder(
  providers: PersistentDeployProvider[],
  preferredProvider?: string,
): PersistentDeployProvider[] {
  const byName = new Map(providers.map((p) => [p.name.toLowerCase(), p]));

  if (preferredProvider && preferredProvider !== 'auto') {
    const preferred = byName.get(preferredProvider.toLowerCase());
    if (!preferred) {
      return providers;
    }
    const rest = providers.filter((p) => p !== preferred);
    return [preferred, ...rest];
  }

  const priority = ['modal', 'azure', 'aws', 'awsgpuprovider'];
  return [...providers].sort((a, b) => {
    const aIdx = priority.indexOf(a.name.toLowerCase());
    const bIdx = priority.indexOf(b.name.toLowerCase());
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });
}

export function shouldFallbackToAzure(
  failedProvider: string,
  error: unknown,
  hasAzure: boolean,
): boolean {
  return failedProvider.toLowerCase() === 'modal' && isRateLimitError(error) && hasAzure;
}
