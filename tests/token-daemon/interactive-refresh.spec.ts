import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('token-daemon interactiveRefresh', () => {
  it('skips interactive OAuth when token is valid (unless --force) and warns when qwen provider missing in config', async () => {
    jest.resetModules();
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

  it('warns when quota-manager marks alias as verify-required even if token is valid', async () => {
    jest.resetModules();
    const ensureValidOAuthToken = jest.fn(async () => {
      throw new Error('ensureValidOAuthToken should not be called for valid token without --force');
    });

    jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken
    }));

    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-quota-authissue-'));
    process.env.HOME = tmpHome;
    const quotaPath = path.join(tmpHome, '.routecodex', 'quota', 'quota-manager.json');
    fs.mkdirSync(path.dirname(quotaPath), { recursive: true });
    fs.writeFileSync(
      quotaPath,
      JSON.stringify(
        {
          providers: {
            'antigravity.xfour8605.claude-sonnet-4-5-thinking': {
              providerKey: 'antigravity.xfour8605.claude-sonnet-4-5-thinking',
              inPool: false,
              reason: 'authVerify',
              authIssue: {
                kind: 'google_account_verification',
                url: 'https://accounts.google.com/signin/continue?x=1',
                message: 'verify your account'
              }
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const tokenDaemonModule = await import('../../src/token-daemon/index.js');
    const tokenDaemon = await import('../../src/token-daemon/token-daemon.js');

    jest.spyOn(tokenDaemon.TokenDaemon, 'findTokenBySelector').mockResolvedValue({
      provider: 'antigravity',
      filePath: '/tmp/antigravity-oauth-4-xfour8605.json',
      sequence: 4,
      alias: 'xfour8605',
      displayName: 'xfour8605',
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
      await tokenDaemonModule.interactiveRefresh('antigravity-oauth-4-xfour8605.json', { force: false });
      expect(ensureValidOAuthToken).not.toHaveBeenCalled();
      expect(warn.mock.calls.some((call) => call.join(' ').includes('verify required'))).toBe(true);
      expect(warn.mock.calls.some((call) => call.join(' ').includes('accounts.google.com/signin/continue'))).toBe(true);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('auto-opens verify URL in Camoufox when headful is enabled', async () => {
    jest.resetModules();
    const ensureValidOAuthToken = jest.fn(async () => {
      throw new Error('ensureValidOAuthToken should not be called for valid token without --force');
    });
    const openAuthInCamoufox = jest.fn(async () => true);

    jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken
    }));
    jest.unstable_mockModule('../../src/providers/core/config/camoufox-launcher.js', () => ({
      shutdownCamoufoxLaunchers: async () => {},
      getCamoufoxProfileDir: () => '/tmp/rc-test-camoufox-profile',
      ensureCamoufoxProfileDir: () => '/tmp/rc-test-camoufox-profile',
      getCamoufoxOsPolicy: () => undefined,
      ensureCamoufoxFingerprintForToken: () => {},
      isCamoufoxAvailable: () => true,
      openAuthInCamoufox
    }));

    const prevHome = process.env.HOME;
    const prevHeadful = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-quota-authissue-open-'));
    process.env.HOME = tmpHome;
    const quotaPath = path.join(tmpHome, '.routecodex', 'quota', 'quota-manager.json');
    fs.mkdirSync(path.dirname(quotaPath), { recursive: true });
    fs.writeFileSync(
      quotaPath,
      JSON.stringify(
        {
          providers: {
            'antigravity.xfour8605.claude-sonnet-4-5-thinking': {
              providerKey: 'antigravity.xfour8605.claude-sonnet-4-5-thinking',
              inPool: false,
              reason: 'authVerify',
              authIssue: {
                kind: 'google_account_verification',
                url: 'https://accounts.google.com/signin/continue?x=1\n\nLearn more',
                message: 'verify your account'
              }
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const tokenDaemonModule = await import('../../src/token-daemon/index.js');
    const tokenDaemon = await import('../../src/token-daemon/token-daemon.js');

    jest.spyOn(tokenDaemon.TokenDaemon, 'findTokenBySelector').mockResolvedValue({
      provider: 'antigravity',
      filePath: '/tmp/antigravity-oauth-4-xfour8605.json',
      sequence: 4,
      alias: 'xfour8605',
      displayName: 'xfour8605',
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
      await tokenDaemonModule.interactiveRefresh('antigravity-oauth-4-xfour8605.json', { force: false });
      expect(openAuthInCamoufox).toHaveBeenCalled();
      const arg = openAuthInCamoufox.mock.calls[0]?.[0];
      expect(String(arg?.url || '')).toContain('https://accounts.google.com/signin/continue');
      expect(String(arg?.url || '')).not.toContain('Learn');
      expect(arg?.provider).toBe('antigravity');
      expect(arg?.alias).toBe('xfour8605');
    } finally {
      warn.mockRestore();
      log.mockRestore();
      if (prevHeadful === undefined) delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      else process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevHeadful;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
