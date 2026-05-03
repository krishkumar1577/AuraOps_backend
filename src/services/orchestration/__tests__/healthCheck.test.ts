import { HealthCheck } from '../healthCheck';
import { DeploymentError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('HealthCheck', () => {
  let healthCheck: HealthCheck;

  beforeEach(() => {
    jest.clearAllMocks();
    healthCheck = new HealthCheck();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkAgent', () => {
    it('should perform successful health check', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const result = await healthCheck.checkAgent('agent-123', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
      });

      expect(result.healthy).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(result.memory.used).toBe(2048);
      expect(result.memory.total).toBe(8192);
      expect(result.gpu.utilization).toBe(35.5);
      expect(result.gpu.memory.used).toBe(4096);
      expect(result.gpu.memory.total).toBe(40960);
      expect(result.uptime).toBe(12345);
      expect(result.timestamp).toBeGreaterThan(0);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('✓ Agent agent-123 health check passed'));
    });

    it('should retry on transient failure then succeed', async () => {
      const mockResponse = {
        healthy: true,
        latency: 50,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        });

      const result = await healthCheck.checkAgent('agent-456', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
      });

      expect(result.healthy).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('should fail after max retries exhausted', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      await expect(
        healthCheck.checkAgent('agent-789', {
          host: 'localhost',
          port: 8000,
          timeout: 5000,
        }),
      ).rejects.toThrow(DeploymentError);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('✗ Agent agent-789 health check failed after 3 attempts'),
      );
    });

    it('should handle HTTP error responses', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(
        healthCheck.checkAgent('agent-http-error', {
          host: 'localhost',
          port: 8000,
          timeout: 5000,
        }),
      ).rejects.toThrow(DeploymentError);

      expect(logger.error).toHaveBeenCalled();
    });

    it('should handle invalid JSON response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      await expect(
        healthCheck.checkAgent('agent-invalid', {
          host: 'localhost',
          port: 8000,
          timeout: 5000,
        }),
      ).rejects.toThrow(DeploymentError);
    });

    it('should handle missing response fields', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          healthy: true,
          // Missing required fields
        }),
      });

      await expect(
        healthCheck.checkAgent('agent-missing-fields', {
          host: 'localhost',
          port: 8000,
          timeout: 5000,
        }),
      ).rejects.toThrow(DeploymentError);
    });

    it('should timeout after specified duration', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(
        async (_url: string, options: any) => {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              reject(new Error('AbortError'));
            });
          });
        },
      );

      await expect(
        healthCheck.checkAgent('agent-timeout', {
          host: 'localhost',
          port: 8000,
          timeout: 100,
        }),
      ).rejects.toThrow(DeploymentError);
    });

    it('should handle network errors', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network unreachable'));

      await expect(
        healthCheck.checkAgent('agent-network', {
          host: 'unreachable.host',
          port: 8000,
          timeout: 5000,
        }),
      ).rejects.toThrow(DeploymentError);
    });

    it('should include error details in thrown exception', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      try {
        await healthCheck.checkAgent('agent-details', {
          host: 'localhost',
          port: 8000,
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentError);
        expect((error as DeploymentError).details).toMatchObject({
          agentId: 'agent-details',
          attempts: 3,
        });
      }
    });

    it('should measure performance and stay under 100ms threshold', async () => {
      const mockResponse = {
        healthy: true,
        latency: 25,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const startTime = Date.now();
      const result = await healthCheck.checkAgent('agent-perf', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
      });
      const elapsed = Date.now() - startTime;

      expect(result.latency).toBeLessThan(100);
      // Allow for test overhead but should be relatively fast
      expect(elapsed).toBeLessThan(200);
    });

    it('should handle unhealthy agent response', async () => {
      const mockResponse = {
        healthy: false,
        latency: 45,
        memory: { used: 7500, total: 8192 },
        gpu: { utilization: 95.5, memory: { used: 40000, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const result = await healthCheck.checkAgent('agent-unhealthy', {
        host: 'localhost',
        port: 8000,
      });

      expect(result.healthy).toBe(false);
      expect(result.memory.used).toBe(7500);
      expect(result.gpu.utilization).toBe(95.5);
    });
  });

  describe('waitReady', () => {
    it('should wait until agent becomes ready', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const result = await healthCheck.waitReady('agent-wait', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
      });

      expect(result).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('✓ Agent agent-wait became ready'));
    });

    it('should retry until timeout', async () => {
      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'));

      const result = await healthCheck.waitReady('agent-wait-timeout', {
        host: 'localhost',
        port: 8000,
        timeout: 300, // Short timeout for testing
        interval: 100,
      });

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('✗ Agent agent-wait-timeout did not become ready'),
      );
    });

    it('should use custom interval', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('Not ready'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        });

      const result = await healthCheck.waitReady('agent-custom-interval', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
        interval: 50,
      });

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should return false on timeout before becoming ready', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Always fails'));

      const result = await healthCheck.waitReady('agent-never-ready', {
        host: 'localhost',
        port: 8000,
        timeout: 200,
        interval: 100,
      });

      expect(result).toBe(false);
    });

    it('should log timing information', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      await healthCheck.waitReady('agent-timing', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting health check wait for agent agent-timing'),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('became ready in'),
      );
    });
  });

  describe('monitorDeployment', () => {
    it('should monitor deployment with continuous checks', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        });

      const results: Array<{
        timestamp: number;
        healthy: boolean;
        latency: number;
        errors: string[];
      }> = [];

      for await (const result of healthCheck.monitorDeployment('agent-monitor', {
        host: 'localhost',
        port: 8000,
        maxDuration: 300,
        interval: 100,
      })) {
        results.push(result);
        if (results.length >= 2) break; // Stop early for testing
      }

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].healthy).toBe(true);
      expect(results[0].latency).toBeGreaterThanOrEqual(0);
      expect(results[0].errors).toEqual([]);
    });

    it('should track errors in monitoring stream', async () => {
      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('Connection error 1'))
        .mockRejectedValueOnce(new Error('Connection error 2'));

      const results: Array<{
        timestamp: number;
        healthy: boolean;
        latency: number;
        errors: string[];
      }> = [];

      for await (const result of healthCheck.monitorDeployment('agent-errors', {
        host: 'localhost',
        port: 8000,
        maxDuration: 300,
        interval: 100,
      })) {
        results.push(result);
        if (results.length >= 2) break;
      }

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].healthy).toBe(false);
      expect(results[0].errors.length).toBeGreaterThan(0);
      expect(results[0].latency).toBe(-1);
    });

    it('should respect maxDuration', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const startTime = Date.now();
      const results: any[] = [];

      for await (const result of healthCheck.monitorDeployment('agent-duration', {
        host: 'localhost',
        port: 8000,
        maxDuration: 250,
        interval: 100,
      })) {
        results.push(result);
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(500); // Should stop soon after maxDuration
      expect(results.length).toBeGreaterThan(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Completed monitoring deployment'),
      );
    });

    it('should reset errors on successful check after failures', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('Connection error'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        });

      const results: Array<{
        timestamp: number;
        healthy: boolean;
        latency: number;
        errors: string[];
      }> = [];

      for await (const result of healthCheck.monitorDeployment('agent-recovery', {
        host: 'localhost',
        port: 8000,
        maxDuration: 300,
        interval: 100,
      })) {
        results.push(result);
        if (results.length >= 2) break;
      }

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].healthy).toBe(false);
      expect(results[0].errors.length).toBeGreaterThan(0);
      expect(results[1].healthy).toBe(true);
      expect(results[1].errors).toEqual([]);
    });

    it('should include timestamps in monitoring results', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      for await (const result of healthCheck.monitorDeployment('agent-timestamp', {
        host: 'localhost',
        port: 8000,
        maxDuration: 200,
        interval: 100,
      })) {
        expect(result.timestamp).toBeGreaterThan(0);
        expect(typeof result.timestamp).toBe('number');
        break;
      }
    });
  });

  describe('edge cases', () => {
    it('should handle rapid consecutive checks', async () => {
      const mockResponse = {
        healthy: true,
        latency: 25,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const checks = Array.from({ length: 5 }, (_, i) =>
        healthCheck.checkAgent(`agent-${i}`, {
          host: 'localhost',
          port: 8000,
        }),
      );

      const results = await Promise.all(checks);

      expect(results).toHaveLength(5);
      expect(results.every((r) => r.healthy)).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(5);
    });

    it('should handle zero memory values gracefully', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 0, total: 0 },
        gpu: { utilization: 0, memory: { used: 0, total: 0 } },
        uptime: 0,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const result = await healthCheck.checkAgent('agent-zero', {
        host: 'localhost',
        port: 8000,
      });

      expect(result.memory.used).toBe(0);
      expect(result.memory.total).toBe(0);
      expect(result.gpu.memory.used).toBe(0);
      expect(result.uptime).toBe(0);
    });

    it('should handle large memory values', async () => {
      const largeValue = 1000000000; // 1GB

      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: largeValue, total: largeValue * 4 },
        gpu: { utilization: 100, memory: { used: largeValue * 2, total: largeValue * 3 } },
        uptime: 999999999,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const result = await healthCheck.checkAgent('agent-large', {
        host: 'localhost',
        port: 8000,
      });

      expect(result.memory.used).toBe(largeValue);
      expect(result.memory.total).toBe(largeValue * 4);
      expect(result.gpu.memory.used).toBe(largeValue * 2);
      expect(result.uptime).toBe(999999999);
    });

    it('should handle special characters in host', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const result = await healthCheck.checkAgent('agent-special', {
        host: '192.168.1.100',
        port: 8000,
      });

      expect(result.healthy).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('192.168.1.100'),
        expect.any(Object),
      );
    });

    it('should handle timeout field omission (use default)', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      // No timeout specified - should use default
      const result = await healthCheck.checkAgent('agent-default-timeout', {
        host: 'localhost',
        port: 8000,
      });

      expect(result.healthy).toBe(true);
    });
  });

  describe('performance', () => {
    it('should complete check within performance budget', async () => {
      const mockResponse = {
        healthy: true,
        latency: 30,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      const startTime = Date.now();
      await healthCheck.checkAgent('agent-budget', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
      });
      const elapsed = Date.now() - startTime;

      // Should be well under 100ms for single check
      expect(elapsed).toBeLessThan(100);
    });

    it('should handle rapid retries efficiently', async () => {
      const mockResponse = {
        healthy: true,
        latency: 25,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        });

      const startTime = Date.now();
      const result = await healthCheck.checkAgent('agent-retry-perf', {
        host: 'localhost',
        port: 8000,
        timeout: 5000,
      });
      const elapsed = Date.now() - startTime;

      expect(result.healthy).toBe(true);
      // With backoff: 100ms + 200ms = 300ms + overhead
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('logging coverage', () => {
    it('should log at appropriate levels', async () => {
      const mockResponse = {
        healthy: true,
        latency: 45,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponse,
      });

      await healthCheck.checkAgent('agent-logging', {
        host: 'localhost',
        port: 8000,
      });

      expect(logger.info).toHaveBeenCalled();
    });

    it('should log warnings for retries', async () => {
      const mockResponse = {
        healthy: true,
        latency: 25,
        memory: { used: 2048, total: 8192 },
        gpu: { utilization: 35.5, memory: { used: 4096, total: 40960 } },
        uptime: 12345,
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockResponse,
        });

      await healthCheck.checkAgent('agent-warn-logging', {
        host: 'localhost',
        port: 8000,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('retry'),
      );
    });

    it('should log errors on failure', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Permanent failure'));

      try {
        await healthCheck.checkAgent('agent-error-logging', {
          host: 'localhost',
          port: 8000,
        });
      } catch {
        // Expected
      }

      expect(logger.error).toHaveBeenCalled();
    });
  });
});
