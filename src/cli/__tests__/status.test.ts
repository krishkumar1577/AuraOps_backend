import axios from 'axios';

jest.mock('axios');
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

import { statusCommand } from '../status';

describe('CLI: auraops status', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should display running deployment status', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-001',
        agentId: 'agent-001',
        workerId: 'worker-001',
        status: 'running',
        startTime: Date.now() - 300000,
        latency: 142,
        gpuUtilization: 85,
      },
    });

    await statusCommand.parseAsync(['node', 'auraops', 'dep-001']);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/deployment/dep-001'),
      expect.any(Object),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('dep-001'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('running'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('agent-001'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('85%'));
  });

  it('should display failed deployment with error', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-002',
        agentId: 'agent-002',
        workerId: 'worker-002',
        status: 'failed',
        startTime: Date.now() - 60000,
        latency: 50,
        error: 'Health check failed after 3 retries',
      },
    });

    await statusCommand.parseAsync(['node', 'auraops', 'dep-002']);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('failed'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Health check failed'));
  });

  it('should handle 404 not found', async () => {
    const axiosError = new Error('Not found') as Error & {
      isAxiosError: boolean;
      response: { status: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 404 };
    mockedAxios.get.mockRejectedValueOnce(axiosError);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await statusCommand.parseAsync(['node', 'auraops', 'dep-nonexistent']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle 400 invalid ID', async () => {
    const axiosError = new Error('Bad request') as Error & {
      isAxiosError: boolean;
      response: { status: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = { status: 400 };
    mockedAxios.get.mockRejectedValueOnce(axiosError);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await statusCommand.parseAsync(['node', 'auraops', 'invalid-id']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid deployment ID'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle connection refused', async () => {
    const axiosError = new Error('ECONNREFUSED') as Error & {
      isAxiosError: boolean;
      code: string;
    };
    axiosError.isAxiosError = true;
    axiosError.code = 'ECONNREFUSED';
    mockedAxios.get.mockRejectedValueOnce(axiosError);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await statusCommand.parseAsync(['node', 'auraops', 'dep-001']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot connect'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should display uptime for running deployment', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-003',
        agentId: 'agent-003',
        workerId: 'worker-003',
        status: 'running',
        startTime: Date.now() - 7200000,
        latency: 100,
      },
    });

    await statusCommand.parseAsync(['node', 'auraops', 'dep-003']);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Uptime'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('2h'));
  });

  it('should show API latency', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-004',
        agentId: 'agent-004',
        workerId: 'worker-004',
        status: 'running',
        startTime: Date.now(),
        latency: 142,
      },
    });

    await statusCommand.parseAsync(['node', 'auraops', 'dep-004']);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('142ms'));
  });
});
