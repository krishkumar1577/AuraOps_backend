/**
 * Bootstrap pricing — INR packs via Razorpay; credits gate hosted GPU deploys.
 * Local `auraops deploy` (user's Modal) stays free forever.
 */

export type CreditPackId = 'starter' | 'builder' | 'scale';

export interface CreditPack {
  id: CreditPackId;
  name: string;
  /** Credits granted after successful payment */
  credits: number;
  /** Price in INR (rupees) */
  priceInr: number;
  description: string;
}

/** 1 hosted deploy (server-side Modal on platform account) costs this many credits. */
export const HOSTED_DEPLOY_CREDIT_COST = 10;

/** Free credits for new signups (tiny trial — protect your Modal bill). */
export const FREE_SIGNUP_CREDITS = 5;

export const CREDIT_PACKS: Record<CreditPackId, CreditPack> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    credits: 50,
    priceInr: 499,
    description: '~5 hosted deploys on platform GPU',
  },
  builder: {
    id: 'builder',
    name: 'Builder',
    credits: 250,
    priceInr: 1999,
    description: '~25 hosted deploys on platform GPU',
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    credits: 1000,
    priceInr: 6999,
    description: '~100 hosted deploys on platform GPU',
  },
};

export function listPacks(): CreditPack[] {
  return Object.values(CREDIT_PACKS);
}

export function getPack(id: string): CreditPack | null {
  return CREDIT_PACKS[id as CreditPackId] ?? null;
}

/** Credits required for a hosted deploy (scales lightly with multi-GPU). */
export function creditsForHostedDeploy(gpuCount = 1): number {
  const gpus = Math.min(8, Math.max(1, gpuCount));
  return HOSTED_DEPLOY_CREDIT_COST * gpus;
}
