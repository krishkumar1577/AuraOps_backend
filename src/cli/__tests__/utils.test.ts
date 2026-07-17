jest.mock('../../utils/config', () => ({
  config: {
    modal_token_id: '',
    modal_token_secret: '',
  },
}));

import * as utils from '../utils';
import { AuraOpsError } from '../../utils/errors';

describe('CLI Utils', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('output functions', () => {
    it('should write success message to stdout', () => {
      utils.success('done');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('done'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('✓'));
    });

    it('should write fail message to stderr', () => {
      utils.fail('broken');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('broken'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('✗'));
    });

    it('should write info message to stdout', () => {
      utils.info('note');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('note'));
    });

    it('should write warn message to stderr', () => {
      utils.warn('careful');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('careful'));
    });

    it('should write brand and divider', () => {
      utils.brand('0.1.0');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('auraops'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('─'));
    });

    it('should write done with timing', () => {
      utils.done('finished', '1.2s');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('finished'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('1.2s'));
    });

    it('should write step with timing', () => {
      utils.step('parsed', '42ms');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('parsed'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('42ms'));
    });

    it('should write step without timing', () => {
      utils.step('parsed');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('parsed'));
    });

    it('should write header', () => {
      utils.header('Title');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Title'));
    });

    it('should write label', () => {
      utils.label('Key', 'Value');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Key'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Value'));
    });

    it('should write blank line', () => {
      utils.blank();
      expect(stdoutSpy).toHaveBeenCalledWith('\n');
    });
  });

  describe('formatMs', () => {
    it('should format milliseconds under 1s', () => {
      expect(utils.formatMs(42)).toBe('42ms');
      expect(utils.formatMs(999)).toBe('999ms');
    });

    it('should format seconds', () => {
      expect(utils.formatMs(1000)).toBe('1.0s');
      expect(utils.formatMs(2500)).toBe('2.5s');
      expect(utils.formatMs(26800)).toBe('26.8s');
    });
  });

  describe('formatBytes', () => {
    it('should format bytes', () => {
      expect(utils.formatBytes(500)).toBe('500B');
    });

    it('should format kilobytes', () => {
      expect(utils.formatBytes(2048)).toBe('2.0KB');
    });

    it('should format megabytes', () => {
      expect(utils.formatBytes(5 * 1024 * 1024)).toBe('5.0MB');
    });

    it('should format gigabytes', () => {
      expect(utils.formatBytes(15 * 1024 * 1024 * 1024)).toBe('15.0GB');
    });
  });

  describe('formatUptime', () => {
    it('should format seconds', () => {
      expect(utils.formatUptime(30000)).toBe('30s');
    });

    it('should format minutes', () => {
      expect(utils.formatUptime(150000)).toBe('2m 30s');
    });

    it('should format hours', () => {
      expect(utils.formatUptime(3700000)).toBe('1h 1m');
    });
  });

  describe('credential helpers', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('isInteractive is false under AURAOPS_NONINTERACTIVE', () => {
      process.env.AURAOPS_NONINTERACTIVE = '1';
      expect(utils.isInteractive()).toBe(false);
    });

    it('ensureModalCredentials uses env when present without prompting', async () => {
      process.env.MODAL_TOKEN_ID = 'tid';
      process.env.MODAL_TOKEN_SECRET = 'tsecret';
      const creds = await utils.ensureModalCredentials();
      expect(creds).toEqual({ tokenId: 'tid', tokenSecret: 'tsecret' });
    });

    it('ensureModalCredentials throws clearly when missing and non-interactive', async () => {
      delete process.env.MODAL_TOKEN_ID;
      delete process.env.MODAL_TOKEN_SECRET;
      process.env.AURAOPS_NONINTERACTIVE = '1';
      // config mock returns empty modal tokens; non-interactive → no prompt
      await expect(utils.ensureModalCredentials()).rejects.toThrow(/MODAL_TOKEN_ID/);
    });

    it('ensureApiToken uses flag/env without prompting', async () => {
      process.env.AURAOPS_API_TOKEN = 'jwt-from-env';
      await expect(utils.ensureApiToken()).resolves.toBe('jwt-from-env');
      await expect(utils.ensureApiToken('jwt-flag')).resolves.toBe('jwt-flag');
    });

    it('ensureApiToken throws when missing and non-interactive', async () => {
      delete process.env.AURAOPS_API_TOKEN;
      delete process.env.AURAOPS_TOKEN;
      process.env.AURAOPS_NONINTERACTIVE = '1';
      await expect(utils.ensureApiToken()).rejects.toThrow(/API token/);
    });

    it('resolveAuthHeaders returns Bearer header', async () => {
      process.env.AURAOPS_API_TOKEN = 'abc.jwt';
      await expect(utils.resolveAuthHeaders()).resolves.toEqual({
        Authorization: 'Bearer abc.jwt',
      });
    });

    it('upsertEnvFile writes and updates keys', async () => {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-env-'));
      const envPath = path.join(dir, '.env');
      await utils.upsertEnvFile(envPath, { FOO: '1', BAR: '2' });
      await utils.upsertEnvFile(envPath, { FOO: 'updated' });
      const text = await fs.readFile(envPath, 'utf-8');
      expect(text).toContain('FOO=updated');
      expect(text).toContain('BAR=2');
      expect(text.match(/^FOO=/gm)?.length).toBe(1);
      await fs.rm(dir, { recursive: true, force: true });
    });
  });

  describe('handleError', () => {
    it('should handle AuraOpsError with details', () => {
      const error = new AuraOpsError('TEST', 'Something failed', 500, {
        workerId: 'w-123',
        cause: 'timeout',
      });
      utils.handleError(error);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Something failed'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('workerId'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('timeout'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle AuraOpsError without details', () => {
      const error = new AuraOpsError('TEST', 'No details');
      utils.handleError(error);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No details'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle standard Error', () => {
      const error = new Error('Standard error');
      utils.handleError(error);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Standard error'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle string error', () => {
      utils.handleError('string error');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('string error'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
