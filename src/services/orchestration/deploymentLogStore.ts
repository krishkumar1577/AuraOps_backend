import { createClient } from 'redis';
import { z } from 'zod';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const DEFAULT_KEY_PREFIX = 'deployment:logs:';
const DEFAULT_TTL_SECONDS = 86_400; // 24 hours
const MAX_LOG_ENTRIES = 5000;

export const DeploymentLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(['info', 'warn', 'error', 'debug']),
  message: z.string(),
  stream: z.enum(['stdout', 'stderr']).optional(),
});

export type DeploymentLogEntry = z.infer<typeof DeploymentLogEntrySchema>;

export interface DeploymentLogRedisClient {
  isOpen: boolean;
  connect(): Promise<void>;
  rPush(key: string, ...values: string[]): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, seconds: number): Promise<boolean>;
  lTrim(key: string, start: number, stop: number): Promise<string>;
}

interface DeploymentLogStoreOptions {
  url?: string;
  keyPrefix?: string;
  ttlSeconds?: number;
}

export class DeploymentLogStore {
  private readonly client: DeploymentLogRedisClient;

  private readonly keyPrefix: string;

  private readonly ttlSeconds: number;

  constructor(client?: DeploymentLogRedisClient | null, options?: DeploymentLogStoreOptions) {
    this.client =
      client ?? (createClient({ url: options?.url }) as unknown as DeploymentLogRedisClient);
    this.keyPrefix = options?.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private key(deploymentId: string): string {
    return `${this.keyPrefix}${deploymentId}`;
  }

  async appendLog(deploymentId: string, entry: DeploymentLogEntry): Promise<void> {
    await this.appendLogs(deploymentId, [entry]);
  }

  async appendLogs(deploymentId: string, entries: DeploymentLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const start = Date.now();
    const key = this.key(deploymentId);

    try {
      await this.ensureConnected();
      const serialized = entries.map(entry => JSON.stringify(DeploymentLogEntrySchema.parse(entry)));
      await this.client.rPush(key, ...serialized);
      await this.client.lTrim(key, -MAX_LOG_ENTRIES, -1);
      await this.client.expire(key, this.ttlSeconds);
      logger.debug(`Appended ${entries.length} log entries for ${deploymentId} (${Date.now() - start}ms)`);
    } catch (error: unknown) {
      throw this.toDeploymentError('Failed to append deployment logs', { deploymentId, key }, error);
    }
  }

  async appendLines(
    deploymentId: string,
    lines: string[],
    stream: 'stdout' | 'stderr',
  ): Promise<void> {
    const nonEmpty = lines
      .map(line => line.trimEnd())
      .filter(line => line.length > 0);

    if (nonEmpty.length === 0) {
      return;
    }

    const timestamp = new Date().toISOString();
    const level = stream === 'stderr' ? 'error' : 'info';
    const entries: DeploymentLogEntry[] = nonEmpty.map(message => ({
      timestamp,
      level,
      message,
      stream,
    }));

    await this.appendLogs(deploymentId, entries);
  }

  async getLogs(deploymentId: string): Promise<DeploymentLogEntry[]> {
    const start = Date.now();
    const key = this.key(deploymentId);

    try {
      await this.ensureConnected();
      const payloads = await this.client.lRange(key, 0, -1);
      const logs: DeploymentLogEntry[] = [];

      for (const payload of payloads) {
        try {
          logs.push(DeploymentLogEntrySchema.parse(JSON.parse(payload)));
        } catch {
          logger.warn(`Skipping invalid deployment log entry for ${deploymentId}`);
        }
      }

      logger.debug(`Retrieved ${logs.length} log entries for ${deploymentId} (${Date.now() - start}ms)`);
      return logs;
    } catch (error: unknown) {
      throw this.toDeploymentError('Failed to get deployment logs', { deploymentId, key }, error);
    }
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

  private toDeploymentError(
    message: string,
    details: Record<string, unknown>,
    error: unknown,
  ): DeploymentError {
    const cause = error instanceof Error ? error.message : String(error);
    return new DeploymentError(message, { ...details, cause });
  }
}
