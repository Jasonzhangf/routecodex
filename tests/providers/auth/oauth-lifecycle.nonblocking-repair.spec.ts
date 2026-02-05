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
});
