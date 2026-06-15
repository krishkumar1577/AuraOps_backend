import axios from 'axios';
import { DeployTelemetry } from '../deployTelemetry';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('DeployTelemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be disabled without API key', () => {
    const telemetry = new DeployTelemetry('');
    expect(telemetry.isEnabled()).toBe(false);
  });

  it('should send contact create when enabled', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    const telemetry = new DeployTelemetry('test-key');

    await telemetry.trackContact('user@example.com', 'user-123');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://app.loops.so/api/v1/contacts/create',
      expect.objectContaining({ email: 'user@example.com', userId: 'user-123' }),
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
    );
  });

  it('should send deploy event when enabled', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    const telemetry = new DeployTelemetry('test-key');

    await telemetry.trackEvent({
      email: 'user@example.com',
      eventName: 'deploy_succeeded',
      properties: { framework: 'pytorch', deployTimeMs: 4100 },
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://app.loops.so/api/v1/events/send',
      expect.objectContaining({
        email: 'user@example.com',
        eventName: 'deploy_succeeded',
      }),
      expect.any(Object),
    );
  });

  it('should not throw when Loops API fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('network error'));
    const telemetry = new DeployTelemetry('test-key');

    await expect(
      telemetry.trackEvent({ email: 'u@x.com', eventName: 'deploy_failed' }),
    ).resolves.toBeUndefined();
  });
});
