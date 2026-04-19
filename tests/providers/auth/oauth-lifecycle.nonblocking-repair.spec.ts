import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('oauth-lifecycle: non-blocking upstream repair', () => {
  jest.setTimeout(10_000);

  it('does not block request for 403 google verify (opens verify URL via Camoufox open-only)', async () => {
    jest.resetModules();
    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      // Interactive path would hang forever if awaited.
      if (opts && opts.openBrowser === true) {
        return await new Promise(() => {});
      }
      return {};
    });

    const openAuthInCamoufox = jest.fn(async () => true);
    jest.unstable_mockModule('../../../src/providers/core/config/camoufox-launcher.js', () => ({
      shutdownCamoufoxLaunchers: async () => {},
      getCamoufoxProfileDir: () => '/tmp/rc-test-camoufox-profile',
      ensureCamoufoxProfileDir: () => '/tmp/rc-test-camoufox-profile',
      getLastCamoufoxLaunchFailureReason: () => null,
      isCamoufoxAvailable: () => true,
      getCamoufoxOsPolicy: () => undefined,
      ensureCamoufoxFingerprintForToken: () => {},
      openAuthInCamoufox
    }));

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');

    const err = {
      statusCode: 403,
      message:
        'HTTP 403: To continue, verify your account at https://accounts.google.com/signin/continue?sarp=1 ...'
    };
    const tokenFile = `/tmp/routecodex-test-antigravity-oauth-${Date.now()}-${Math.random()}.json`;

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await Promise.race([
      handleUpstreamInvalidOAuthToken(
        'antigravity',
        { type: 'oauth', tokenFile } as any,
        err as any,
        { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))
    ]);
    warn.mockRestore();

    expect(result).not.toBe('timeout');
    expect(result).toBe(false);

    expect(ensureValid).not.toHaveBeenCalled();
    expect(openAuthInCamoufox).toHaveBeenCalled();
    const url = openAuthInCamoufox.mock.calls[0]?.[0]?.url;
    expect(String(url || '')).toContain('accounts.google.com/signin/continue');
  });


  it('prefers accounts verify URL when upstream payload also contains support link', async () => {
    jest.resetModules();
    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      if (opts && opts.openBrowser === true) {
        return await new Promise(() => {});
      }
      return {};
    });

    const openAuthInCamoufox = jest.fn(async () => true);
    jest.unstable_mockModule('../../../src/providers/core/config/camoufox-launcher.js', () => ({
      shutdownCamoufoxLaunchers: async () => {},
      getCamoufoxProfileDir: () => '/tmp/rc-test-camoufox-profile',
      ensureCamoufoxProfileDir: () => '/tmp/rc-test-camoufox-profile',
      getLastCamoufoxLaunchFailureReason: () => null,
      isCamoufoxAvailable: () => true,
      getCamoufoxOsPolicy: () => undefined,
      ensureCamoufoxFingerprintForToken: () => {},
      openAuthInCamoufox
    }));

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');

    const err = {
      statusCode: 403,
      message:
        'HTTP 403: {"error":{"code":403,"message":"To continue, verify your account at\n\nhttps://accounts.google.com/signin/continue?sarp=1&scc=1&authuser\n\nLearn more\n\nhttps://support.google.com/accounts?p=al_alert\n"}}'
    };
    const tokenFile = '/tmp/routecodex-test-antigravity-oauth-' + Date.now() + '-' + Math.random() + '.json';

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await Promise.race([
      handleUpstreamInvalidOAuthToken(
        'antigravity',
        { type: 'oauth', tokenFile } as any,
        err as any,
        { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))
    ]);
    warn.mockRestore();

    expect(result).not.toBe('timeout');
    expect(result).toBe(false);
    expect(openAuthInCamoufox).toHaveBeenCalled();
    const url = openAuthInCamoufox.mock.calls[0]?.[0]?.url;
    expect(String(url || '')).toContain('accounts.google.com/signin/continue');
    expect(String(url || '')).not.toContain('support.google.com/accounts?p=al_alert');
  });

  it('tries silent refresh first for non-qwen invalid token, then starts interactive in background', async () => {
    jest.resetModules();
    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      // Silent refresh path fails immediately.
      if (opts && opts.openBrowser === false) {
        throw new Error('refresh failed');
      }
      // Interactive path would hang forever if awaited.
      if (opts && opts.openBrowser === true) {
        return await new Promise(() => {});
      }
      return {};
    });

    const err = { statusCode: 401, message: 'HTTP 401: unauthorized (invalid_token)' };
    const tokenFile = `/tmp/routecodex-test-qwen-oauth-${Date.now()}-${Math.random()}.json`;

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const result = await Promise.race([
      handleUpstreamInvalidOAuthToken(
        'gemini',
        { type: 'oauth', tokenFile } as any,
        err as any,
        { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))
    ]);

    expect(result).not.toBe('timeout');
    expect(result).toBe(false);

    expect(ensureValid).toHaveBeenCalled();
    const callArgs = ensureValid.mock.calls.map((c) => c[2]);
    expect(callArgs.some((o) => o && o.openBrowser === false)).toBe(true);
    expect(callArgs.some((o) => o && o.openBrowser === true)).toBe(true);
    expect(
      callArgs.some((o) => o && o.openBrowser === false && o.forceRefresh === true)
    ).toBe(false);
  });

  it('qwen permanent refresh failure without stable api_key does not persist noRefresh and does not start interactive flow', async () => {
    jest.resetModules();
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-qwen-refresh-perm-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-4-jasonqueque.json');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(
      tokenFile,
      JSON.stringify(
        {
          access_token: 'access-old',
          refresh_token: 'refresh-old',
          resource_url: 'portal.qwen.ai'
        },
        null,
        2
      ),
      'utf8'
    );

    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      if (opts && opts.openBrowser === false) {
        throw new Error('Token refresh failed (permanent): OAuth error: invalid_request - Invalid refresh token or client_id');
      }
      if (opts && opts.openBrowser === true) {
        throw new Error('interactive path should not be reached');
      }
      return {};
    });

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const result = await handleUpstreamInvalidOAuthToken(
      'qwen',
      { type: 'qwen-oauth', tokenFile } as any,
      { statusCode: 401, message: 'HTTP 401: unauthorized (invalid_token)' } as any,
      { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
    );

    expect(result).toBe(false);
    expect(ensureValid).toHaveBeenCalledTimes(1);
    expect(ensureValid.mock.calls[0]?.[2]?.openBrowser).toBe(false);

    const updated = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    expect(updated.norefresh ?? updated.noRefresh).toBeUndefined();

    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('qwen alias token file without stable api_key does not persist noRefresh and does not start interactive flow', async () => {
    jest.resetModules();
    const prevHome = process.env.HOME;
    const prevRccHome = process.env.RCC_HOME;
    const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-qwen-refresh-alias-'));
    process.env.HOME = tmpHome;
    process.env.RCC_HOME = path.join(tmpHome, '.rcc');
    process.env.ROUTECODEX_HOME = path.join(tmpHome, '.rcc');

    const authDir = path.join(tmpHome, '.rcc', 'auth');
    const tokenFile = path.join(authDir, 'qwen-oauth-4-jasonqueque.json');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      tokenFile,
      JSON.stringify(
        {
          access_token: 'access-old',
          refresh_token: 'refresh-old',
          resource_url: 'portal.qwen.ai'
        },
        null,
        2
      ),
      'utf8'
    );

    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      if (opts && opts.openBrowser === false) {
        throw new Error('Token refresh failed (permanent): OAuth error: invalid_request - Invalid refresh token or client_id');
      }
      if (opts && opts.openBrowser === true) {
        throw new Error('interactive path should not be reached');
      }
      return {};
    });

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const result = await handleUpstreamInvalidOAuthToken(
      'qwen',
      { type: 'qwen-oauth', tokenFile: 'qwen-oauth-4-jasonqueque' } as any,
      { statusCode: 401, message: 'HTTP 401: unauthorized (invalid_token)' } as any,
      { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
    );

    expect(result).toBe(false);
    expect(ensureValid).toHaveBeenCalledTimes(1);
    expect(ensureValid.mock.calls[0]?.[2]?.openBrowser).toBe(false);

    const updated = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    expect(updated.norefresh ?? updated.noRefresh).toBeUndefined();

    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevRccHome === undefined) delete process.env.RCC_HOME;
    else process.env.RCC_HOME = prevRccHome;
    if (prevRouteCodexHome === undefined) delete process.env.ROUTECODEX_HOME;
    else process.env.ROUTECODEX_HOME = prevRouteCodexHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('qwen mirrored api_key noRefresh does not suppress silent repair attempt', async () => {
    jest.resetModules();
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-qwen-norefresh-mirrored-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-4-jasonqueque.json');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(
      tokenFile,
      JSON.stringify(
        {
          access_token: 'access-old',
          api_key: 'access-old',
          apiKey: 'access-old',
          refresh_token: 'refresh-old',
          resource_url: 'portal.qwen.ai',
          norefresh: true,
          noRefresh: true,
          type: 'qwen'
        },
        null,
        2
      ),
      'utf8'
    );

    const ensureValid = jest.fn(async () => ({}));
    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const result = await handleUpstreamInvalidOAuthToken(
      'qwen',
      { type: 'qwen-oauth', tokenFile } as any,
      { statusCode: 401, message: 'HTTP 401: unauthorized (invalid_token)' } as any,
      { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
    );

    expect(result).toBe(true);
    expect(ensureValid).toHaveBeenCalledTimes(1);
    expect(ensureValid.mock.calls[0]?.[2]?.openBrowser).toBe(false);

    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('qwen blocking repair is now silent-refresh only and never launches interactive auth', async () => {
    jest.resetModules();
    const prevHome = process.env.HOME;
    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-qwen-blocking-auto-'));
    process.env.HOME = tmpHome;
    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      if (opts && opts.openBrowser === false) {
        throw new Error('Token refresh failed (permanent): OAuth error: invalid_request - Invalid refresh token or client_id');
      }
      return {};
    });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');
      const result = await handleUpstreamInvalidOAuthToken(
        'qwen',
        { type: 'qwen-oauth', tokenFile: path.join(tmpHome, 'auth', `qwen-oauth-${Date.now()}.json`) } as any,
        { statusCode: 401, message: 'HTTP 401: unauthorized (invalid_token)' } as any,
        { allowBlocking: true, ensureValidOAuthToken: ensureValid as any }
      );

      expect(result).toBe(false);
      // No interactive fallback: only one silent refresh attempt should be made.
      expect(ensureValid).toHaveBeenCalledTimes(1);
      expect(ensureValid.mock.calls[0]?.[2]).toMatchObject({
        openBrowser: false
      });
    } finally {
      warn.mockRestore();
      if (prevAutoMode === undefined) delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      else process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('qwen auto-disabled path keeps retrying silent refresh and never enters interactive repair gating', async () => {
    jest.resetModules();
    const prevHome = process.env.HOME;
    const prevMax = process.env.ROUTECODEX_OAUTH_INTERACTIVE_MAX_ATTEMPTS;
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-oauth-repair-limit-'));
    process.env.HOME = tmp;
    process.env.ROUTECODEX_OAUTH_INTERACTIVE_MAX_ATTEMPTS = '3';

    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      if (opts && opts.openBrowser === false) {
        throw new Error('refresh failed');
      }
      throw new Error('interactive failed');
    });

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');

    const err = { statusCode: 401, message: 'HTTP 401: unauthorized (invalid_token)' };
    const tokenFile = path.join(tmp, 'auth', `qwen-oauth-${Date.now()}.json`);

    for (let i = 0; i < 3; i += 1) {
      await handleUpstreamInvalidOAuthToken(
        'qwen',
        { type: 'oauth', tokenFile } as any,
        err as any,
        { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
      );
    }

    const callCountAfterThree = ensureValid.mock.calls.length;

    await handleUpstreamInvalidOAuthToken(
      'qwen',
      { type: 'oauth', tokenFile } as any,
      err as any,
      { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
    );

    expect(callCountAfterThree).toBe(3);
    expect(ensureValid.mock.calls.length).toBe(4);
    expect(
      ensureValid.mock.calls.every((call) => call?.[2]?.openBrowser === false)
    ).toBe(true);

    if (prevMax === undefined) delete process.env.ROUTECODEX_OAUTH_INTERACTIVE_MAX_ATTEMPTS;
    else process.env.ROUTECODEX_OAUTH_INTERACTIVE_MAX_ATTEMPTS = prevMax;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
});
