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

import { logsCommand } from '../logs';

describe('CLI: auraops logs', () => {
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

  it('should display logs for a deployment', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-001',
        logs: [
          { timestamp: '2026-05-04T10:00:00Z', level: 'info', message: 'Agent started' },
          { timestamp: '2026-05-04T10:00:01Z', level: 'info', message: 'Loading model' },
          { timestamp: '2026-05-04T10:00:08Z', level: 'info', message: 'Model loaded, ready for inference' },
        ],
      },
    });

    await logsCommand.parseAsync(['node', 'auraops', 'dep-001']);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/deployment/dep-001/logs'),
      expect.any(Object),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Agent started'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Loading model'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('ready for inference'));
  });

  it('should handle empty logs', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, deploymentId: 'dep-002', logs: [] },
    });

    await logsCommand.parseAsync(['node', 'auraops', 'dep-002']);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('No logs available'));
  });

  it('should respect --tail flag', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-003',
        logs: [
          { timestamp: '2026-05-04T10:00:00Z', level: 'info', message: 'Line 1' },
          { timestamp: '2026-05-04T10:00:01Z', level: 'info', message: 'Line 2' },
          { timestamp: '2026-05-04T10:00:02Z', level: 'info', message: 'Line 3' },
          { timestamp: '2026-05-04T10:00:03Z', level: 'info', message: 'Line 4' },
          { timestamp: '2026-05-04T10:00:04Z', level: 'info', message: 'Line 5' },
        ],
      },
    });

    await logsCommand.parseAsync(['node', 'auraops', 'dep-003', '-t', '2']);

    const writeCallArgs = stdoutSpy.mock.calls.map((c: string[]) => c[0]);
    const logLines = writeCallArgs.filter((a: string) => a.includes('Line'));
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toContain('Line 4');
    expect(logLines[1]).toContain('Line 5');
  });

  it('should format log levels with color codes', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-004',
        logs: [
          { timestamp: '2026-05-04T10:00:00Z', level: 'info', message: 'Info log' },
          { timestamp: '2026-05-04T10:00:01Z', level: 'warn', message: 'Warning log' },
          { timestamp: '2026-05-04T10:00:02Z', level: 'error', message: 'Error log' },
        ],
      },
    });

    await logsCommand.parseAsync(['node', 'auraops', 'dep-004']);

    const allOutput = stdoutSpy.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOutput).toContain('WARN');
    expect(allOutput).toContain('ERROR');
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

    await logsCommand.parseAsync(['node', 'auraops', 'dep-nonexistent']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
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

    await logsCommand.parseAsync(['node', 'auraops', 'dep-001']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot connect'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should include timestamps in output', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-005',
        logs: [
          { timestamp: '2026-05-04T10:15:00Z', level: 'info', message: 'Test' },
        ],
      },
    });

    await logsCommand.parseAsync(['node', 'auraops', 'dep-005']);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('2026-05-04T10:15:00Z'));
  });
});
