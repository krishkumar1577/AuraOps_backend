import {
  ModalProvider,
  clearModalPriceCache,
  normalizeModalGpuType,
} from '../modalProvider';

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
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.MODAL_PRICE_T4;
    delete process.env.MODAL_PRICE_A100;
    delete process.env.AURAOPS_GPU_PRICE_JSON;
    clearModalPriceCache();
    provider = new ModalProvider();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getPrice', () => {
    it('should return guide map price for T4', async () => {
      expect(await provider.getPrice('T4')).toBe(0.59);
    });

    it('should normalize aliases (t4 → T4)', async () => {
      expect(normalizeModalGpuType('t4')).toBe('T4');
      expect(await provider.getPrice('t4')).toBe(0.59);
      expect(await provider.getPrice('a100-80gb')).toBe(3.95);
    });

    it('should honor MODAL_PRICE_* env overrides', async () => {
      process.env.MODAL_PRICE_T4 = '0.42';
      clearModalPriceCache();
      expect(await provider.getPrice('T4')).toBe(0.42);
      expect(await provider.getPrice('t4')).toBe(0.42);
    });

    it('should honor AURAOPS_GPU_PRICE_JSON flat and nested modal overrides', async () => {
      process.env.AURAOPS_GPU_PRICE_JSON = JSON.stringify({ T4: 0.33, A100: 2.1 });
      clearModalPriceCache();
      expect(await provider.getPrice('T4')).toBe(0.33);

      process.env.AURAOPS_GPU_PRICE_JSON = JSON.stringify({ modal: { H100: 4.0 } });
      clearModalPriceCache();
      expect(await provider.getPrice('H100')).toBe(4.0);
    });

    it('should return 0 for unknown GPU type', async () => {
      expect(await provider.getPrice('UnknownGPU')).toBe(0);
    });
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
