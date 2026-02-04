import { jest } from '@jest/globals';
import { handleUpstreamInvalidOAuthToken } from '../../../src/providers/auth/oauth-lifecycle.js';

describe('oauth-lifecycle: non-blocking upstream repair', () => {
  jest.setTimeout(10_000);

  it('does not block request for 403 google verify (runs interactive repair in background)', async () => {
    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      // Interactive path would hang forever if awaited.
      if (opts && opts.openBrowser === true) {
        return await new Promise(() => {});
      }
      return {};
    });

    const err = {
      statusCode: 403,
      message:
        'HTTP 403: To continue, verify your account at https://accounts.google.com/signin/continue?sarp=1 ...'
    };
    const tokenFile = `/tmp/routecodex-test-antigravity-oauth-${Date.now()}-${Math.random()}.json`;

    const result = await Promise.race([
      handleUpstreamInvalidOAuthToken(
        'antigravity',
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
    expect(callArgs.some((o) => o && o.openBrowser === true)).toBe(true);
  });

  it('tries silent refresh first for generic invalid token, then starts interactive in background', async () => {
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
