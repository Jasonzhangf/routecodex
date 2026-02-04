import { describe, expect, it, jest } from '@jest/globals';

describe('token-daemon interactiveRefresh', () => {
  it('skips interactive OAuth when token is valid (unless --force) and warns when qwen provider missing in config', async () => {
    const ensureValidOAuthToken = jest.fn(async () => {
      throw new Error('ensureValidOAuthToken should not be called for valid token without --force');
    });
    const loadRouteCodexConfig = jest.fn(async () => ({
      userConfig: { virtualrouter: { providers: [] } }
    }));

    jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken
    }));
    jest.unstable_mockModule('../../src/config/routecodex-config-loader.js', () => ({
      loadRouteCodexConfig
    }));

    const tokenDaemonModule = await import('../../src/token-daemon/index.js');
    const tokenDaemon = await import('../../src/token-daemon/token-daemon.js');

    jest.spyOn(tokenDaemon.TokenDaemon, 'findTokenBySelector').mockResolvedValue({
      provider: 'qwen',
      filePath: '/tmp/qwen-oauth-1-default.json',
      sequence: 1,
      alias: 'default',
      displayName: 'default',
      state: {
        hasAccessToken: true,
        hasRefreshToken: true,
        hasApiKey: false,
        expiresAt: Date.now() + 60 * 60_000,
        msUntilExpiry: 60 * 60_000,
        status: 'valid',
        noRefresh: false
      }
    } as any);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await tokenDaemonModule.interactiveRefresh('qwen-oauth-1-default.json', { force: false });
      expect(ensureValidOAuthToken).not.toHaveBeenCalled();
      expect(loadRouteCodexConfig).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

