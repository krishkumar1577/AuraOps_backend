import { ModalClient, Sandbox, App } from 'modal';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { config } from '../../../utils/config';
import type { GPUAcquisitionSpec, GPUInstance, WorkerInstance } from '../../../types/orchestration.types';
import { BaseGPUProvider } from './baseProvider';
import { ModalAppDeployer } from '../modalAppDeployer';
import type { BlueprintJSON } from '../../../types/blueprint.types';

const GPU_MEMORY_MAP: Record<string, number> = {
  T4: 16,
  L4: 24,
  A10G: 24,
  A100: 40,
  'A100-80GB': 80,
  H100: 80,
  H200: 141,
  L40S: 48,
};

/** Guide defaults (Modal pricing page); overridable via env. Not a live market feed. */
const GPU_PRICE_MAP: Record<string, number> = {
  T4: 0.59,
  L4: 0.79,
  A10G: 1.10,
  A100: 3.00,
  'A100-80GB': 3.95,
  H100: 4.89,
};

/** Short TTL cache for resolved Modal prices (guide map + env overrides). */
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;

interface PriceCacheEntry {
  prices: Record<string, number>;
  expiresAt: number;
}

let priceCache: PriceCacheEntry | null = null;

/** Normalize aliases: t4/T4, a100-80gb → A100-80GB. */
export function normalizeModalGpuType(gpuType: string): string {
  const raw = gpuType.trim();
  if (!raw) return raw;

  const upper = raw.toUpperCase().replace(/_/g, '-');
  const aliases: Record<string, string> = {
    T4: 'T4',
    L4: 'L4',
    A10G: 'A10G',
    A10: 'A10G',
    A100: 'A100',
    'A100-40GB': 'A100',
    'A100-40': 'A100',
    'A100-80GB': 'A100-80GB',
    'A100-80': 'A100-80GB',
    H100: 'H100',
    L40S: 'L40S',
    H200: 'H200',
  };

  if (aliases[upper]) return aliases[upper];

  const known = Object.keys(GPU_PRICE_MAP).find((k) => k.toUpperCase() === upper);
  return known ?? raw;
}

function parsePositivePrice(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = parseFloat(value);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return n;
}

/**
 * Load price overrides from:
 * - MODAL_PRICE_T4 / MODAL_PRICE_A100_80GB / …
 * - AURAOPS_GPU_PRICE_JSON flat `{"T4":0.55}` or nested `{"modal":{"T4":0.55}}`
 */
function loadModalPriceOverrides(): Record<string, number> {
  const overrides: Record<string, number> = {};

  const jsonRaw = process.env.AURAOPS_GPU_PRICE_JSON;
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
      const modalSection = parsed.modal ?? parsed.Modal;
      const flatOrNested =
        modalSection && typeof modalSection === 'object' && !Array.isArray(modalSection)
          ? (modalSection as Record<string, unknown>)
          : parsed;

      for (const [key, value] of Object.entries(flatOrNested)) {
        if (typeof value === 'number' && value > 0) {
          overrides[normalizeModalGpuType(key)] = value;
        } else if (typeof value === 'string') {
          const n = parsePositivePrice(value);
          if (n !== undefined) overrides[normalizeModalGpuType(key)] = n;
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }

  for (const key of Object.keys(GPU_PRICE_MAP)) {
    const envKey = `MODAL_PRICE_${key.replace(/-/g, '_').toUpperCase()}`;
    const n = parsePositivePrice(process.env[envKey]);
    if (n !== undefined) {
      overrides[key] = n;
    }
  }

  // Also accept MODAL_PRICE_t4 style (any case) via scanning known types only — already covered.

  return overrides;
}

/** Resolve guide map + overrides; cached briefly so env reloads pick up without thrashing. */
export function resolveModalPrices(forceRefresh = false): Record<string, number> {
  const now = Date.now();
  if (!forceRefresh && priceCache && priceCache.expiresAt > now) {
    return priceCache.prices;
  }

  const prices = { ...GPU_PRICE_MAP, ...loadModalPriceOverrides() };
  priceCache = { prices, expiresAt: now + PRICE_CACHE_TTL_MS };
  return prices;
}

/** Test helper: clear in-memory price cache. */
export function clearModalPriceCache(): void {
  priceCache = null;
}

function selectGPU(minMemoryGB: number): string {
  const ranked = Object.entries(GPU_MEMORY_MAP)
    .filter(([, mem]) => mem >= minMemoryGB)
    .sort(([, a], [, b]) => a - b);

  if (ranked.length === 0) {
    throw new DeploymentError(`No GPU available with ${minMemoryGB}GB+ memory`);
  }
  return ranked[0][0];
}

/** Format Modal GPU spec: "T4" for 1 GPU, "T4:2" for multi-GPU. */
function formatModalGpu(gpuType: string, count: number): string {
  return count > 1 ? `${gpuType}:${count}` : gpuType;
}

interface ActiveSandbox {
  sandbox: Sandbox;
  sandboxId: string;
  gpuType: string;
  memoryGB: number;
  framework: string;
  createdAt: number;
}

interface DeployedApp {
  deploymentId: string;
  appName: string;
  endpointUrl: string;
  deployedAt: number;
}

export class ModalProvider extends BaseGPUProvider {
  name = 'Modal';
  private client: ModalClient | null = null;
  private app: App | null = null;
  private activeSandboxes: Map<string, ActiveSandbox> = new Map();
  private deployedApps: Map<string, DeployedApp> = new Map();

  async validateConnection(): Promise<void> {
    const start = Date.now();
    const tokenId = this.credentials['token_id'];
    const tokenSecret = this.credentials['token_secret'];

    if (!tokenId || !tokenSecret) {
      throw new DeploymentError('Modal: token_id and token_secret credentials required');
    }

    this.client = new ModalClient({ tokenId, tokenSecret });
    this.app = await this.client.apps.fromName('auraops', { createIfMissing: true });
    logger.info(`Modal connection validated in ${Date.now() - start}ms`);
  }

  async listAvailable(): Promise<GPUInstance[]> {
    this.requireConnection();

    const prices = resolveModalPrices();
    return Object.entries(GPU_MEMORY_MAP).map(([gpuType, memoryGB]) => ({
      id: `modal-${gpuType.toLowerCase()}`,
      gpuType,
      memoryGB,
      available: true,
      pricePerHour: prices[gpuType] ?? GPU_PRICE_MAP[gpuType] ?? 0,
    }));
  }

  async acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance> {
    const start = Date.now();
    this.requireConnection();
    this.validateGPUSpec(spec);

    const gpuType = selectGPU(spec.minMemory);
    const gpuCount = spec.gpuCount ?? 1;
    const gpuSpec = formatModalGpu(gpuType, gpuCount);
    const memoryGB = GPU_MEMORY_MAP[gpuType];

    logger.info(`Acquiring Modal sandbox: gpu=${gpuSpec}, framework=${spec.framework}`);

    try {
      const image = this.client!.images.fromRegistry('python:3.11-slim');
      const workerId = this.generateWorkerId();

      const sandbox = await this.client!.sandboxes.create(this.app!, image, {
        gpu: gpuSpec,
        timeoutMs: 300_000,
        name: workerId,
      });

      this.activeSandboxes.set(workerId, {
        sandbox,
        sandboxId: sandbox.sandboxId,
        gpuType,
        memoryGB,
        framework: spec.framework,
        createdAt: Date.now(),
      });

      const tunnelInfo = await sandbox.tunnels(30_000).catch(() => ({}));
      const firstTunnel = Object.values(tunnelInfo)[0];

      logger.info(`Modal sandbox acquired in ${Date.now() - start}ms: ${sandbox.sandboxId}`);

      return {
        workerId,
        gpuId: sandbox.sandboxId,
        ipAddress: firstTunnel?.host ?? 'modal-sandbox',
        port: firstTunnel?.port ?? 0,
        gpuType,
        memoryGB,
        framework: spec.framework,
        status: 'ready',
        secureRuntimeActive: false,
      };
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('Modal: GPU acquisition failed', {
        cause: error instanceof Error ? error.message : String(error),
        gpuType,
      });
    }
  }

  async releaseGPU(workerId: string): Promise<void> {
    const start = Date.now();
    this.requireConnection();

    const entry = this.activeSandboxes.get(workerId);
    if (!entry) {
      throw new DeploymentError(`Modal: Worker not found: ${workerId}`);
    }

    try {
      await entry.sandbox.terminate();
      this.activeSandboxes.delete(workerId);
      logger.info(`Modal sandbox released in ${Date.now() - start}ms: ${workerId}`);
    } catch (error) {
      throw new DeploymentError('Modal: GPU release failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getPrice(gpuType: string): Promise<number> {
    const normalized = normalizeModalGpuType(gpuType);
    const prices = resolveModalPrices();
    return prices[normalized] ?? 0;
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.requireConnection();
      return true;
    } catch {
      return false;
    }
  }

  async execInSandbox(workerId: string, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const entry = this.activeSandboxes.get(workerId);
    if (!entry) {
      throw new DeploymentError(`Modal: Worker not found: ${workerId}`);
    }

    const proc = await entry.sandbox.exec(command);
    const stdout = await proc.stdout.readText();
    const stderr = await proc.stderr.readText();
    const exitCode = await proc.wait();

    return { stdout, stderr, exitCode };
  }

  async getGpuUtilization(workerId: string): Promise<number | null> {
    const start = Date.now();

    try {
      this.requireConnection();

      if (!this.activeSandboxes.has(workerId)) {
        return null;
      }

      const utilizationResult = await this.execInSandbox(workerId, [
        'nvidia-smi',
        '--query-gpu=utilization.gpu',
        '--format=csv,noheader,nounits',
      ]);

      if (utilizationResult.exitCode === 0 && utilizationResult.stdout.trim()) {
        const parsed = parseFloat(utilizationResult.stdout.trim().split('\n')[0]);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          const utilization = Math.round(parsed);
          logger.info(`Modal GPU utilization for ${workerId}: ${utilization}% in ${Date.now() - start}ms`);
          return utilization;
        }
      }

      const memoryResult = await this.execInSandbox(workerId, [
        'nvidia-smi',
        '--query-gpu=memory.used,memory.total',
        '--format=csv,noheader,nounits',
      ]);

      if (memoryResult.exitCode === 0 && memoryResult.stdout.trim()) {
        const [usedStr, totalStr] = memoryResult.stdout.trim().split(',').map((value) => value.trim());
        const used = parseFloat(usedStr);
        const total = parseFloat(totalStr);

        if (!Number.isNaN(used) && !Number.isNaN(total) && total > 0) {
          const estimate = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
          logger.info(
            `Modal GPU utilization estimate for ${workerId}: ${estimate}% in ${Date.now() - start}ms`,
          );
          return estimate;
        }
      }

      return null;
    } catch (error) {
      logger.warn(
        `Modal GPU utilization unavailable for ${workerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  getActiveSandboxCount(): number {
    return this.activeSandboxes.size;
  }

  async fetchPersistentAppLogs(deploymentId: string): Promise<{ stdout: string; stderr: string }> {
    return ModalAppDeployer.fetchAppLogs(deploymentId);
  }

  async fetchSandboxLogs(workerId: string): Promise<{ stdout: string; stderr: string }> {
    const start = Date.now();

    try {
      const result = await this.execInSandbox(workerId, [
        'sh',
        '-c',
        'if [ -f /tmp/auraops-agent.log ]; then tail -n 200 /tmp/auraops-agent.log; fi',
      ]);

      logger.info(`Fetched sandbox logs for ${workerId} in ${Date.now() - start}ms`);
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Sandbox log fetch failed for ${workerId}: ${msg}`);
      return { stdout: '', stderr: msg };
    }
  }

  /**
   * Deploy a persistent Modal app with live HTTPS endpoint
   */
  async deployPersistentApp(
    deploymentId: string,
    blueprint: BlueprintJSON,
    deployConfig?: {
      skipPipInstall?: boolean;
      cachedImageRef?: string;
      gpuCount?: number;
      enableMcp?: boolean;
      projectPath?: string;
    },
  ): Promise<{ endpointUrl: string; appName: string; imageRef: string }> {
    const start = Date.now();

    try {
      if (!this.connected) {
        await this.connect({
          token_id: config.modal_token_id,
          token_secret: config.modal_token_secret,
        });
      }

      // VALIDATION: Check blueprint has all required fields
      if (!blueprint) {
        throw new DeploymentError('Invalid blueprint: blueprint is null/undefined', { deploymentId });
      }

      if (!blueprint.framework?.framework) {
        logger.error('Blueprint validation failed: missing framework', {
          deploymentId,
          blueprint: JSON.stringify(blueprint, null, 2),
        });
        throw new DeploymentError('Invalid blueprint: missing framework.framework', { deploymentId });
      }

      if (!blueprint.deploymentConfig?.gpuMemoryGB) {
        logger.error('Blueprint validation failed: missing deploymentConfig.gpuMemoryGB', {
          deploymentId,
          deploymentConfig: JSON.stringify(blueprint.deploymentConfig),
        });
        throw new DeploymentError('Invalid blueprint: missing deploymentConfig.gpuMemoryGB', { deploymentId });
      }

      // Log the blueprint for debugging
      logger.info(`Blueprint received for Modal deployment:`, {
        deploymentId,
        framework: blueprint.framework.framework,
        gpuMemory: blueprint.deploymentConfig.gpuMemoryGB,
        hasDependencyLock: !!blueprint.dependencyLock,
        dependencyLockSize: blueprint.dependencyLock ? Object.keys(blueprint.dependencyLock).length : 0,
      });

      // Log cache status
      const skipPipInstall = deployConfig?.skipPipInstall ?? false;
      const cachedImageRef = deployConfig?.cachedImageRef;
      logger.info(
        `Deploying with ${skipPipInstall ? 'cached' : 'fresh'} image for ${blueprint.framework.framework}:${blueprint.framework.version}`,
      );

      const gpuCount = deployConfig?.gpuCount ?? 1;
      logger.info(
        `Deploying persistent Modal app: deploymentId=${deploymentId}, framework=${blueprint.framework.framework}, gpus=${gpuCount}`,
      );

      // Step 1: Generate modal_app.py
      const appContent = ModalAppDeployer.generateModalApp(blueprint, deploymentId, deployConfig);
      logger.info(`Generated modal_app.py content:\n${appContent}`);

      // Step 2: Write to temporary file (package user project when projectPath provided)
      const appPath = await ModalAppDeployer.writeModalApp(
        appContent,
        deploymentId,
        deployConfig?.projectPath,
      );

      // Step 3: Deploy and get endpoint URL
      const endpointUrl = await ModalAppDeployer.deployApp(appPath, deploymentId);

      // Step 4: Store deployment record
      const appName = `auraops-${deploymentId}`;
      const imageRef = cachedImageRef || `auraops-${deploymentId}`;
      this.deployedApps.set(deploymentId, {
        deploymentId,
        appName,
        endpointUrl,
        deployedAt: Date.now(),
      });

      logger.info(
        `✓ Modal app deployed in ${Date.now() - start}ms: ${endpointUrl}`,
      );

      return {
        endpointUrl,
        appName,
        imageRef,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        `Modal persistent app deployment failed in modalProvider: ${errorMsg}`,
        { deploymentId, error: errorMsg },
      );
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('Modal: Persistent app deployment failed', {
        cause: errorMsg,
        deploymentId,
      });
    }
  }

  /**
   * Get endpoint URL for deployed app
   */
  getDeployedAppUrl(deploymentId: string): string | null {
    const deployed = this.deployedApps.get(deploymentId);
    return deployed ? deployed.endpointUrl : null;
  }

  /**
   * Stop a persistent Modal app
   */
  async stopPersistentApp(deploymentId: string): Promise<void> {
    try {
      this.requireConnection();

      await ModalAppDeployer.stopApp(deploymentId);
      this.deployedApps.delete(deploymentId);

      logger.info(`Modal app stopped: ${deploymentId}`);
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('Modal: Failed to stop app', {
        cause: error instanceof Error ? error.message : String(error),
        deploymentId,
      });
    }
  }

  getDeployedAppCount(): number {
    return this.deployedApps.size;
  }

  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}
