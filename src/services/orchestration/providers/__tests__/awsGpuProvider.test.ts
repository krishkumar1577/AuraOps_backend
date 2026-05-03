import { AWSGPUProvider } from '../awsGpuProvider';
import { EC2Client } from '@aws-sdk/client-ec2';

jest.mock('@aws-sdk/client-ec2');
jest.mock('@aws-sdk/client-pricing');

describe('AWSGPUProvider', () => {
  let provider: AWSGPUProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new AWSGPUProvider();
  });

  describe('connect', () => {
    it('should connect with valid credentials', async () => {
      const credentials = {
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
        region: 'us-east-1',
      };

      const mockSend = jest.fn().mockResolvedValue({ Reservations: [] });
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect(credentials);

      expect(EC2Client).toHaveBeenCalled();
    });

    it('should throw error when access key is missing', async () => {
      const credentials = { aws_secret_access_key: 'secret...' };

      await expect(provider.connect(credentials)).rejects.toThrow();
    });

    it('should throw error when secret key is missing', async () => {
      const credentials = { aws_access_key_id: 'AKIA...' };

      await expect(provider.connect(credentials)).rejects.toThrow();
    });

    it('should throw error on API validation failure', async () => {
      const credentials = {
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      };

      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error('Invalid credentials')),
      }));

      await expect(provider.connect(credentials)).rejects.toThrow('Failed to validate credentials');
    });
  });

  describe('listAvailable', () => {
    beforeEach(async () => {
      const mockSend = jest.fn().mockResolvedValue({ Reservations: [] });
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect({
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      });
    });

    it('should list available GPU instance types', async () => {
      const available = await provider.listAvailable();

      expect(available.length).toBeGreaterThan(0);
      expect(available[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          gpuType: expect.stringMatching(/T4|V100|A100/),
          memoryGB: expect.any(Number),
          available: true,
          region: 'us-east-1',
        }),
      );
    });

    it('should throw error when not connected', async () => {
      const disconnected = new AWSGPUProvider();

      await expect(disconnected.listAvailable()).rejects.toThrow('Not connected');
    });
  });

  describe('validation', () => {
    beforeEach(async () => {
      const mockSend = jest.fn().mockResolvedValue({ Reservations: [] });
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect({
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      });
    });

    it('should validate GPU spec - minMemory', async () => {
      const spec = { minMemory: -1, framework: 'pytorch' };

      await expect(provider.acquireGPU(spec)).rejects.toThrow('minMemory must be greater than 0');
    });

    it('should validate GPU spec - framework required', async () => {
      const spec = { minMemory: 30, framework: '' };

      await expect(provider.acquireGPU(spec)).rejects.toThrow('framework is required');
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      const mockSend = jest.fn();
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect({
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      });
    });

    it('should throw error on launch failure', async () => {
      const mockSend = jest.fn().mockRejectedValue(new Error('Launch failed'));
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect({
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      });

      const spec = { minMemory: 30, framework: 'pytorch' };

      await expect(provider.acquireGPU(spec)).rejects.toThrow('GPU acquisition failed');
    });

    it('should throw error for unknown worker release', async () => {
      await expect(provider.releaseGPU('unknown-worker')).rejects.toThrow('Worker not found');
    });
  });

  describe('getPrice', () => {
    beforeEach(async () => {
      const mockSend = jest.fn().mockResolvedValue({ Reservations: [] });
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect({
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      });
    });

    it('should return 0 for unknown GPU type', async () => {
      const price = await provider.getPrice('UnknownType');

      expect(price).toBe(0);
    });

    it('should handle pricing API errors gracefully', async () => {
      const price = await provider.getPrice('p3.2xlarge');

      expect(typeof price).toBe('number');
    });
  });

  describe('healthCheck', () => {
    it('should return true when connected', async () => {
      const mockSend = jest.fn().mockResolvedValue({ Reservations: [] });
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect({
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      });

      const health = await provider.healthCheck();

      expect(health).toBe(true);
    });

    it('should return false on error', async () => {
      const mockSend = jest.fn().mockRejectedValue(new Error('Connection failed'));
      (EC2Client as jest.Mock).mockImplementation(() => ({
        send: mockSend,
        config: { region: 'us-east-1' },
      }));

      await provider.connect({
        aws_access_key_id: 'AKIA...',
        aws_secret_access_key: 'secret...',
      });

      const health = await provider.healthCheck();

      expect(health).toBe(false);
    });
  });
});
