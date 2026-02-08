import { jest } from '@jest/globals';

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

  it('tries silent refresh first for generic invalid token, then starts interactive in background', async () => {
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
        'qwen',
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
  });

  it('stops reauth after three interactive attempts (no further ensureValid calls)', async () => {
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

    expect(ensureValid.mock.calls.length).toBe(callCountAfterThree);

    if (prevMax === undefined) delete process.env.ROUTECODEX_OAUTH_INTERACTIVE_MAX_ATTEMPTS;
    else process.env.ROUTECODEX_OAUTH_INTERACTIVE_MAX_ATTEMPTS = prevMax;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
});
