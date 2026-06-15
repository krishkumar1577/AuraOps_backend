import { ModalProvider } from '../modalProvider';

jest.mock('modal', () => ({
  ModalClient: jest.fn().mockImplementation(() => ({
    apps: {
      fromName: jest.fn().mockResolvedValue({ name: 'auraops' }),
    },
    images: {
      fromRegistry: jest.fn().mockReturnValue({ tag: 'python:3.11-slim' }),
    },
    sandboxes: {
      create: jest.fn(),
    },
    close: jest.fn(),
  })),
  Sandbox: jest.fn(),
  App: jest.fn(),
}));

describe('ModalProvider', () => {
  let provider: ModalProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new ModalProvider();
  });

  describe('getGpuUtilization', () => {
    it('should return null when worker sandbox is not active', async () => {
      await provider.connect({ token_id: 'test-id', token_secret: 'test-secret' });

      const utilization = await provider.getGpuUtilization('missing-worker');

      expect(utilization).toBeNull();
    });

    it('should parse nvidia-smi utilization output', async () => {
      await provider.connect({ token_id: 'test-id', token_secret: 'test-secret' });

      const execSpy = jest
        .spyOn(provider, 'execInSandbox')
        .mockResolvedValueOnce({ stdout: '42\n', stderr: '', exitCode: 0 });

      const activeSandboxes = (provider as unknown as { activeSandboxes: Map<string, unknown> }).activeSandboxes;
      activeSandboxes.set('worker-1', { sandboxId: 'sb-1' });

      const utilization = await provider.getGpuUtilization('worker-1');

      expect(execSpy).toHaveBeenCalledWith('worker-1', [
        'nvidia-smi',
        '--query-gpu=utilization.gpu',
        '--format=csv,noheader,nounits',
      ]);
      expect(utilization).toBe(42);
    });

    it('should estimate utilization from GPU memory when utilization query fails', async () => {
      await provider.connect({ token_id: 'test-id', token_secret: 'test-secret' });

      const execSpy = jest
        .spyOn(provider, 'execInSandbox')
        .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 127 })
        .mockResolvedValueOnce({ stdout: '4096, 8192\n', stderr: '', exitCode: 0 });

      const activeSandboxes = (provider as unknown as { activeSandboxes: Map<string, unknown> }).activeSandboxes;
      activeSandboxes.set('worker-2', { sandboxId: 'sb-2' });

      const utilization = await provider.getGpuUtilization('worker-2');

      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(utilization).toBe(50);
    });

    it('should return null when sandbox exec throws', async () => {
      await provider.connect({ token_id: 'test-id', token_secret: 'test-secret' });

      jest.spyOn(provider, 'execInSandbox').mockRejectedValue(new Error('exec failed'));

      const activeSandboxes = (provider as unknown as { activeSandboxes: Map<string, unknown> }).activeSandboxes;
      activeSandboxes.set('worker-3', { sandboxId: 'sb-3' });

      const utilization = await provider.getGpuUtilization('worker-3');

      expect(utilization).toBeNull();
    });
  });
});
