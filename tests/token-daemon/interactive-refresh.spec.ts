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


  it('uses accounts verify URL when quota authIssue contains escaped newline payload', async () => {
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
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-quota-authissue-escaped-'));
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
                url: 'To continue, verify your account at\n\nhttps://accounts.google.com/signin/continue?sarp=1&scc=1&authuser\n\nLearn more\n\nhttps://support.google.com/accounts?p=al_alert\n',
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
      expect(String(arg?.url || '')).toContain('accounts.google.com/signin/continue');
      expect(String(arg?.url || '')).not.toContain('support.google.com/accounts?p=al_alert');
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


  it('recovers verify URL from provider-errors log when quota snapshot only has help URL', async () => {
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
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-quota-authissue-recover-'));
    process.env.HOME = tmpHome;
    const quotaDir = path.join(tmpHome, '.routecodex', 'quota');
    const quotaPath = path.join(quotaDir, 'quota-manager.json');
    const errorLogPath = path.join(quotaDir, 'provider-errors.ndjson');
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
                url: 'https://support.google.com/accounts?p=al_alert\"',
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
    fs.writeFileSync(
      errorLogPath,
      [
        JSON.stringify({
          ts: new Date().toISOString(),
          providerKey: 'antigravity.xfour8605.claude-sonnet-4-5-thinking',
          message:
            'HTTP 403: {"error":{"message":"To continue, verify your account at\n\nhttps://accounts.google.com/signin/continue?sarp=1&scc=1&authuser\n\nLearn more\n\nhttps://support.google.com/accounts?p=al_alert\n"}}',
          details: {
            authIssue: {
              kind: 'google_account_verification',
              url: 'https://accounts.google.com/signin/continue?sarp=1&scc=1&authuser\n\nLearn'
            }
          }
        })
      ] .join('\n') + '\n',
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
      expect(String(arg?.url || '')).toContain('accounts.google.com/signin/continue');
      expect(String(arg?.url || '')).not.toContain('support.google.com/accounts?p=al_alert');
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

  it('falls back to Google support URL when quota authIssue URL is truncated', async () => {
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
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-quota-authissue-truncated-'));
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
                url: 'https://accounts.goo...[truncated',
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
      expect(String(arg?.url || '')).toBe('https://support.google.com/accounts?p=al_alert');
      expect(String(arg?.url || '')).not.toContain('truncated');
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


  it('uses open-only mode for manual interactive OAuth refresh', async () => {
    jest.resetModules();
    const ensureValidOAuthToken = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken
    }));
    jest.unstable_mockModule('../../src/token-portal/local-token-portal.js', () => ({
      ensureLocalTokenPortalEnv: async () => {},
      shutdownLocalTokenPortalEnv: async () => {}
    }));

    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    const prevOpenOnly = process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'gemini';
    process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
    process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = '0';

    const tokenDaemonModule = await import('../../src/token-daemon/index.js');
    const tokenDaemon = await import('../../src/token-daemon/token-daemon.js');

    jest.spyOn(tokenDaemon.TokenDaemon, 'findTokenBySelector').mockResolvedValue({
      provider: 'antigravity',
      filePath: '/tmp/antigravity-oauth-3-antonsoltan.json',
      sequence: 3,
      alias: 'antonsoltan',
      displayName: 'antonsoltan',
      state: {
        hasAccessToken: false,
        hasRefreshToken: true,
        hasApiKey: false,
        expiresAt: null,
        msUntilExpiry: -1,
        status: 'invalid',
        noRefresh: false
      }
    } as any);

    let seenAutoMode = '';
    let seenAutoConfirm = '';
    let seenOpenOnly = '';
    ensureValidOAuthToken.mockImplementationOnce(async () => {
      seenAutoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '');
      seenAutoConfirm = String(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM || '');
      seenOpenOnly = String(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY || '');
    });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await tokenDaemonModule.interactiveRefresh('antigravity-oauth-3-antonsoltan.json', { force: true, mode: 'manual' });
      expect(ensureValidOAuthToken).toHaveBeenCalled();
      expect(seenAutoMode).toBe('');
      expect(seenAutoConfirm).toBe('');
      expect(seenOpenOnly).toBe('1');
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('gemini');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
      expect(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY).toBe('0');
    } finally {
      warn.mockRestore();
      log.mockRestore();
      if (prevAutoMode === undefined) delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      else process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
      if (prevAutoConfirm === undefined) delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      else process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
      if (prevOpenOnly === undefined) delete process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
      else process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = prevOpenOnly;
    }
  });

  it('keeps camoufox browser for manual iflow interactive OAuth', async () => {
    jest.resetModules();
    const ensureValidOAuthToken = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken
    }));
    jest.unstable_mockModule('../../src/token-portal/local-token-portal.js', () => ({
      ensureLocalTokenPortalEnv: async () => {},
      shutdownLocalTokenPortalEnv: async () => {}
    }));

    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    const prevOpenOnly = process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;

    process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'iflow';
    process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
    process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = '0';

    const tokenDaemonModule = await import('../../src/token-daemon/index.js');
    const tokenDaemon = await import('../../src/token-daemon/token-daemon.js');

    jest.spyOn(tokenDaemon.TokenDaemon, 'findTokenBySelector').mockResolvedValue({
      provider: 'iflow',
      filePath: '/tmp/iflow-oauth-3-138.json',
      sequence: 3,
      alias: '138',
      displayName: '138',
      state: {
        hasAccessToken: false,
        hasRefreshToken: true,
        hasApiKey: false,
        expiresAt: null,
        msUntilExpiry: -1,
        status: 'invalid',
        noRefresh: false
      }
    } as any);

    let seenBrowser = '';
    let seenAutoMode = '';
    let seenAutoConfirm = '';
    let seenOpenOnly = '';
    ensureValidOAuthToken.mockImplementationOnce(async () => {
      seenBrowser = String(process.env.ROUTECODEX_OAUTH_BROWSER || '');
      seenAutoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '');
      seenAutoConfirm = String(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM || '');
      seenOpenOnly = String(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY || '');
    });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await tokenDaemonModule.interactiveRefresh('iflow-oauth-3-138.json', { force: true, mode: 'manual' });
      expect(ensureValidOAuthToken).toHaveBeenCalled();
      expect(seenBrowser).toBe('camoufox');
      expect(seenAutoMode).toBe('');
      expect(seenAutoConfirm).toBe('');
      expect(seenOpenOnly).toBe('1');
      expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe('camoufox');
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('iflow');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
      expect(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY).toBe('0');
    } finally {
      warn.mockRestore();
      log.mockRestore();
      if (prevBrowser === undefined) delete process.env.ROUTECODEX_OAUTH_BROWSER;
      else process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
      if (prevAutoMode === undefined) delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      else process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
      if (prevAutoConfirm === undefined) delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      else process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
      if (prevOpenOnly === undefined) delete process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
      else process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = prevOpenOnly;
    }
  });

  it('falls back from auto to one headful manual retry', async () => {
    jest.resetModules();
    const ensureValidOAuthToken = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken
    }));
    jest.unstable_mockModule('../../src/token-portal/local-token-portal.js', () => ({
      ensureLocalTokenPortalEnv: async () => {},
      shutdownLocalTokenPortalEnv: async () => {}
    }));

    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    const prevOpenOnly = process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
    const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'qwen';
    process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
    process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = '0';
    delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;

    const tokenDaemonModule = await import('../../src/token-daemon/index.js');
    const tokenDaemon = await import('../../src/token-daemon/token-daemon.js');

    jest.spyOn(tokenDaemon.TokenDaemon, 'findTokenBySelector').mockResolvedValue({
      provider: 'qwen',
      filePath: '/tmp/qwen-oauth-2-135.json',
      sequence: 2,
      alias: '135',
      displayName: '135',
      state: {
        hasAccessToken: false,
        hasRefreshToken: true,
        hasApiKey: false,
        expiresAt: null,
        msUntilExpiry: -1,
        status: 'invalid',
        noRefresh: false
      }
    } as any);

    const seenCalls: Array<{ autoMode: string; autoConfirm: string; openOnly: string; devMode: string }> = [];
    ensureValidOAuthToken
      .mockImplementationOnce(async () => {
        seenCalls.push({
          autoMode: String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || ''),
          autoConfirm: String(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM || ''),
          openOnly: String(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY || ''),
          devMode: String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '')
        });
        throw new Error('auto launch failed');
      })
      .mockImplementationOnce(async () => {
        seenCalls.push({
          autoMode: String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || ''),
          autoConfirm: String(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM || ''),
          openOnly: String(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY || ''),
          devMode: String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '')
        });
      });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await tokenDaemonModule.interactiveRefresh('qwen-oauth-2-135.json', { force: true, mode: 'auto' });
      expect(ensureValidOAuthToken).toHaveBeenCalledTimes(2);
      expect(seenCalls[0]?.autoMode).toBe('qwen');
      expect(seenCalls[1]?.autoMode).toBe('');
      expect(seenCalls[1]?.autoConfirm).toBe('');
      expect(seenCalls[1]?.openOnly).toBe('1');
      expect(seenCalls[1]?.devMode).toBe('1');
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('qwen');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
      expect(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY).toBe('0');
      expect(String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '')).toBe('');
    } finally {
      warn.mockRestore();
      log.mockRestore();
      if (prevAutoMode === undefined) delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      else process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
      if (prevAutoConfirm === undefined) delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      else process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
      if (prevOpenOnly === undefined) delete process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
      else process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = prevOpenOnly;
      if (prevDevMode === undefined) delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      else process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
    }
  });

});
