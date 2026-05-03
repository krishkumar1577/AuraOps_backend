import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface HealthStatus {
  healthy: boolean;
  latency: number; // milliseconds
  memory: { used: number; total: number }; // bytes
  gpu: { utilization: number; memory: { used: number; total: number } };
  uptime: number; // milliseconds
  timestamp: number;
}

export interface HealthCheckConfig {
  host: string;
  port: number;
  timeout?: number;
  interval?: number;
}

interface AgentHealthResponse {
  healthy: boolean;
  latency: number;
  memory: { used: number; total: number };
  gpu: { utilization: number; memory: { used: number; total: number } };
  uptime: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 1000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 100; // 100ms, 200ms, 400ms for retries

export class HealthCheck {
  constructor() {}

  /**
   * Check single agent health with retry logic
   */
  async checkAgent(
    agentId: string,
    config: HealthCheckConfig,
  ): Promise<HealthStatus> {
    const { host, port, timeout = DEFAULT_TIMEOUT_MS } = config;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const status = await this.performHealthCheck(host, port, timeout);
        logger.info(
          `✓ Agent ${agentId} health check passed - latency: ${status.latency}ms, uptime: ${status.uptime}ms`,
        );
        return status;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < MAX_RETRIES - 1) {
          const backoffMs = RETRY_BACKOFF_MS * Math.pow(2, attempt);
          logger.warn(
            `Agent ${agentId} health check attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${backoffMs}ms: ${lastError.message}`,
          );
          await this.delay(backoffMs);
        }
      }
    }

    logger.error(
      `✗ Agent ${agentId} health check failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
    );
    throw new DeploymentError(`Health check failed for agent ${agentId}`, {
      agentId,
      attempts: MAX_RETRIES,
      cause: lastError?.message,
    });
  }

  /**
   * Wait for agent to be healthy (with timeout)
   */
  async waitReady(
    agentId: string,
    config: HealthCheckConfig & { timeout: number; interval?: number },
  ): Promise<boolean> {
    const {
      host,
      port,
      timeout,
      interval = DEFAULT_INTERVAL_MS,
    } = config;
    const startTime = Date.now();
    let lastError: Error | null = null;

    logger.info(
      `Starting health check wait for agent ${agentId}, timeout: ${timeout}ms, interval: ${interval}ms`,
    );

    while (Date.now() - startTime < timeout) {
      try {
        await this.performHealthCheck(host, port, timeout);
        const elapsedMs = Date.now() - startTime;
        logger.info(
          `✓ Agent ${agentId} became ready in ${elapsedMs}ms`,
        );
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const elapsedMs = Date.now() - startTime;
        logger.debug(
          `Agent ${agentId} not ready yet (${elapsedMs}ms elapsed): ${lastError.message}`,
        );
        await this.delay(interval);
      }
    }

    const elapsedMs = Date.now() - startTime;
    logger.error(
      `✗ Agent ${agentId} did not become ready within ${timeout}ms (${elapsedMs}ms elapsed): ${lastError?.message}`,
    );
    return false;
  }

  /**
   * Monitor deployment continuously (async iterator)
   */
  async *monitorDeployment(
    agentId: string,
    config: {
      host: string;
      port: number;
      maxDuration: number;
      interval: number;
    },
  ): AsyncGenerator<{
    timestamp: number;
    healthy: boolean;
    latency: number;
    errors: string[];
  }> {
    const { host, port, maxDuration, interval } = config;
    const startTime = Date.now();
    const errors: string[] = [];

    logger.info(
      `Starting monitoring deployment for agent ${agentId}, max duration: ${maxDuration}ms, interval: ${interval}ms`,
    );

    while (Date.now() - startTime < maxDuration) {
      const timestamp = Date.now();

      try {
        const status = await this.performHealthCheck(
          host,
          port,
          DEFAULT_TIMEOUT_MS,
        );
        logger.debug(
          `Agent ${agentId} monitoring check passed - latency: ${status.latency}ms`,
        );
        yield {
          timestamp,
          healthy: true,
          latency: status.latency,
          errors: [],
        };
        errors.length = 0; // Reset error tracking on success
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        errors.push(errorMsg);
        logger.warn(`Agent ${agentId} monitoring check failed: ${errorMsg}`);
        yield {
          timestamp,
          healthy: false,
          latency: -1,
          errors: [...errors],
        };
      }

      await this.delay(interval);
    }

    const elapsedMs = Date.now() - startTime;
    logger.info(
      `Completed monitoring deployment for agent ${agentId} after ${elapsedMs}ms`,
    );
  }

  /**
   * Internal method to perform actual health check via HTTP
   */
  private async performHealthCheck(
    host: string,
    port: number,
    timeout: number,
  ): Promise<HealthStatus> {
    const url = `http://${host}:${port}/health`;
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as unknown;
      const latency = Date.now() - startTime;

      // Validate response structure
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as Record<string, any>).healthy !== 'boolean' ||
        typeof (data as Record<string, any>).latency !== 'number' ||
        !(data as Record<string, any>).memory ||
        !(data as Record<string, any>).gpu ||
        typeof (data as Record<string, any>).uptime !== 'number'
      ) {
        throw new Error('Invalid health response structure');
      }

      const typedData = data as AgentHealthResponse;

      return {
        healthy: typedData.healthy,
        latency,
        memory: {
          used: typedData.memory.used ?? 0,
          total: typedData.memory.total ?? 0,
        },
        gpu: {
          utilization: typedData.gpu.utilization ?? 0,
          memory: {
            used: typedData.gpu.memory?.used ?? 0,
            total: typedData.gpu.memory?.total ?? 0,
          },
        },
        uptime: typedData.uptime,
        timestamp: startTime,
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new DeploymentError(`Health check timeout after ${timeout}ms`, {
          host,
          port,
          timeout,
        });
      }

      throw new DeploymentError(`Health check failed: ${errorMsg}`, {
        host,
        port,
        latency,
        url,
      });
    }
  }

  /**
   * Helper: delay for a given number of milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
