import { jest } from '@jest/globals';

const axiosPost = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: { post: axiosPost }
}));

describe('antigravity-quota-client parsing', () => {
  beforeEach(() => {
    axiosPost.mockReset();
  });

  test('treats missing remainingFraction (with resetTime) as exhausted', async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        models: {
          'claude-sonnet-4-5-thinking': {
            quotaInfo: { resetTime: '2026-01-21T11:40:31Z' }
          }
        }
      }
    });

    const { fetchAntigravityQuotaSnapshot } = await import(
      '../../../../src/providers/core/runtime/antigravity-quota-client.js'
    );

    const snapshot = await fetchAntigravityQuotaSnapshot('https://example.invalid', 'token');
    expect(snapshot).toBeTruthy();
    expect(snapshot?.models['claude-sonnet-4-5-thinking']).toEqual({
      remainingFraction: 0,
      resetTimeRaw: '2026-01-21T11:40:31Z'
    });
  });

  test('parses remainingFraction when present', async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        models: {
          'claude-sonnet-4-5-thinking': {
            quotaInfo: { remainingFraction: '0.25', resetTime: '2026-01-21T11:40:31Z' }
          }
        }
      }
    });

    const { fetchAntigravityQuotaSnapshot } = await import(
      '../../../../src/providers/core/runtime/antigravity-quota-client.js'
    );

    const snapshot = await fetchAntigravityQuotaSnapshot('https://example.invalid', 'token');
    expect(snapshot).toBeTruthy();
    expect(snapshot?.models['claude-sonnet-4-5-thinking']?.remainingFraction).toBeCloseTo(0.25);
    expect(snapshot?.models['claude-sonnet-4-5-thinking']?.resetTimeRaw).toBe('2026-01-21T11:40:31Z');
  });
});

