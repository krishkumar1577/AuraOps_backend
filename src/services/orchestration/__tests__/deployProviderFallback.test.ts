import {
  isRateLimitError,
  resolvePersistentProviderOrder,
  shouldFallbackToAzure,
} from '../deployProviderFallback';
import { DeploymentError } from '../../../utils/errors';

describe('deployProviderFallback', () => {
  const modal = { name: 'Modal', deployPersistentApp: jest.fn() };
  const azure = { name: 'Azure', deployPersistentApp: jest.fn() };
  const aws = { name: 'AWS', deployPersistentApp: jest.fn() };

  it('should detect 429 rate limit errors', () => {
    expect(isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new DeploymentError('Rate limited', { statusCode: 429 }))).toBe(true);
    expect(isRateLimitError(new Error('Connection refused'))).toBe(false);
  });

  it('should order providers with preferred provider first', () => {
    const ordered = resolvePersistentProviderOrder([modal, azure, aws], 'azure');
    expect(ordered[0].name).toBe('Azure');
  });

  it('should default order Modal → Azure → AWS', () => {
    const ordered = resolvePersistentProviderOrder([aws, azure, modal], 'auto');
    expect(ordered.map((p) => p.name)).toEqual(['Modal', 'Azure', 'AWS']);
  });

  it('should trigger Azure fallback when Modal returns 429', () => {
    expect(
      shouldFallbackToAzure('Modal', new Error('429 rate limit exceeded'), true),
    ).toBe(true);
    expect(
      shouldFallbackToAzure('Modal', new Error('connection timeout'), true),
    ).toBe(false);
    expect(
      shouldFallbackToAzure('Modal', new Error('429 rate limit'), false),
    ).toBe(false);
  });
});
