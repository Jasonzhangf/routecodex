import { jest } from '@jest/globals';

describe('oauth-lifecycle: iflow refresh-endpoint rejection handling', () => {
  it('treats iflow refresh endpoint rejection as interactive-repair signal', async () => {
    jest.resetModules();
    const { shouldTriggerInteractiveOAuthRepair } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const err = new Error(
      'Token refresh failed after 1 attempts: OAuth token endpoint rejected request (500): 当前找我聊的人太多了，可以晚点再来问我哦。'
    );
    expect(shouldTriggerInteractiveOAuthRepair('iflow', err)).toBe(true);
  });

  it('does not trigger interactive repair for iflow 434 blocked account', async () => {
    jest.resetModules();
    const { shouldTriggerInteractiveOAuthRepair } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const err = Object.assign(
      new Error('HTTP 400: iFlow business error (434): Access to the current AK has been blocked due to unauthorized requests'),
      {
        response: {
          status: 400,
          data: {
            upstream: {
              status: '434',
              msg: 'Access to the current AK has been blocked due to unauthorized requests'
            }
          }
        }
      }
    );
    expect(shouldTriggerInteractiveOAuthRepair('iflow', err)).toBe(false);
  });

  it('non-blocking path no longer launches automatic OAuth for iflow refresh rejection', async () => {
    jest.resetModules();
    const ensureCalls: Array<{ openBrowser?: boolean; autoMode: string; openOnly: string; devMode: string }> = [];
    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      ensureCalls.push({
        openBrowser: opts?.openBrowser,
        autoMode: String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || ''),
        openOnly: String(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY || ''),
        devMode: String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '')
      });
    });

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const tokenFile = `/tmp/routecodex-iflow-refresh-${Date.now()}-${Math.random()}.json`;
    const err = new Error(
      'Token refresh failed after 1 attempts: OAuth token endpoint rejected request (500): 当前找我聊的人太多了，可以晚点再来问我哦。'
    );

    const result = await handleUpstreamInvalidOAuthToken(
      'iflow',
      { type: 'oauth', tokenFile } as any,
      err,
      { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
    );
    expect(result).toBe(false);

    for (let i = 0; i < 20 && ensureCalls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(ensureCalls).toHaveLength(0);
  });

  it('switches no longer attempt manual fallback when auto flow reports missing element', async () => {
    jest.resetModules();
    const ensureCalls: Array<{ openBrowser?: boolean; autoMode: string; openOnly: string; devMode: string }> = [];
    const ensureValid = jest.fn(async (_providerType: string, _auth: any, opts: any) => {
      ensureCalls.push({
        openBrowser: opts?.openBrowser,
        autoMode: String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || ''),
        openOnly: String(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY || ''),
        devMode: String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '')
      });
    });

    const { handleUpstreamInvalidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');
    const tokenFile = `/tmp/routecodex-iflow-refresh-element-${Date.now()}-${Math.random()}.json`;
    const err = new Error(
      'Token refresh failed after 1 attempts: OAuth token endpoint rejected request (500): 当前找我聊的人太多了，可以晚点再来问我哦。'
    );

    const result = await handleUpstreamInvalidOAuthToken(
      'iflow',
      { type: 'oauth', tokenFile } as any,
      err,
      { allowBlocking: false, ensureValidOAuthToken: ensureValid as any }
    );
    expect(result).toBe(false);

    for (let i = 0; i < 20 && ensureCalls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(ensureCalls).toHaveLength(0);
  });
});
