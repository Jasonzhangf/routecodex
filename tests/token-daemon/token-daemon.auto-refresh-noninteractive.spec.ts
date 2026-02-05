import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

  it('persists noRefresh and auto-suspends on permanent refresh failures', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-token-daemon-perm-'));
    process.env.HOME = tmpHome;

    try {
      jest.resetModules();
      const ensureValidOAuthToken = jest.fn(async () => {
        throw new Error('Token refresh failed (permanent): OAuth error: invalid_request - Invalid refresh token or client_id');
      });

      jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
        ensureValidOAuthToken
      }));

      const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
      await fs.mkdir(path.dirname(tokenFile), { recursive: true });
      await fs.writeFile(
        tokenFile,
        `${JSON.stringify(
          {
            access_token: 'test-access',
            refresh_token: 'test-refresh',
            expires_in: 3600,
            expires_at: Date.now() + 30_000
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      const mtimeBefore = (await fs.stat(tokenFile)).mtimeMs;

      const mod = await import('../../src/token-daemon/token-daemon.js');
      const daemon = new mod.TokenDaemon({ intervalMs: 999999, refreshAheadMinutes: 30 });
      (daemon as any).ensurePortalEnvironment = async () => true;

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await (daemon as any).trySilentRefresh({
          provider: 'qwen',
          filePath: tokenFile,
          sequence: 1,
          alias: 'default',
          displayName: 'default',
          state: {
            hasAccessToken: true,
            hasRefreshToken: true,
            hasApiKey: false,
            expiresAt: Date.now() + 30_000,
            msUntilExpiry: 30_000,
            status: 'expiring',
            noRefresh: false
          }
        });
      } finally {
        warn.mockRestore();
      }

      const tokenAfter = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
      expect(tokenAfter.noRefresh).toBe(true);
      expect(tokenAfter.norefresh).toBe(true);

      const mtimeAfter = (await fs.stat(tokenFile)).mtimeMs;
      expect(mtimeAfter).toBeGreaterThan(mtimeBefore);

      const { resolveTokenHistoryFilePath } = await import('../../src/token-daemon/history-store.js');
      const historyPath = resolveTokenHistoryFilePath();
      const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));
      const key = `qwen::${tokenFile}`;
      expect(history.tokens[key]?.autoSuspended).toBe(true);
      expect(history.tokens[key]?.lastTokenMtime).toBe(mtimeAfter);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});
