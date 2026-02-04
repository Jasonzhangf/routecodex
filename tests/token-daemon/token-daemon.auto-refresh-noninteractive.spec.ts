import { describe, expect, it, jest } from '@jest/globals';

describe('TokenDaemon ensureTokenWithOverrides', () => {
  it('does not request interactive OAuth for non-camoufox background refresh', async () => {
    const ensureValidOAuthToken = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken
    }));

    const mod = await import('../../src/token-daemon/token-daemon.js');
    const daemon = new mod.TokenDaemon({ intervalMs: 999999, refreshAheadMinutes: 5 });

    await (daemon as any).ensureTokenWithOverrides({
      provider: 'qwen',
      filePath: '/tmp/qwen-oauth-1-default.json',
      sequence: 1,
      alias: 'default',
      displayName: 'default',
      state: {
        hasAccessToken: true,
        hasRefreshToken: true,
        hasApiKey: false,
        expiresAt: Date.now() + 1000,
        msUntilExpiry: 1000,
        status: 'expiring',
        noRefresh: false
      }
    });

    expect(ensureValidOAuthToken).toHaveBeenCalledTimes(1);
    const opts = ensureValidOAuthToken.mock.calls[0]?.[2];
    expect(opts).toMatchObject({
      openBrowser: false,
      forceReacquireIfRefreshFails: false,
      forceReauthorize: false
    });
  });
});

