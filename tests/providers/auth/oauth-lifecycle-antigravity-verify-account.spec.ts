import { jest } from '@jest/globals';

describe('oauth-lifecycle: antigravity verify-account 403 triggers interactive OAuth', () => {
  jest.setTimeout(10_000);

  it('treats 403 verify your account as interactive reauth trigger', async () => {
    const mod = await import('../../../src/providers/auth/oauth-lifecycle.js');

    const ok = mod.shouldTriggerInteractiveOAuthRepair('antigravity', {
      statusCode: 403,
      message:
        'HTTP 403: To continue, verify your account at https://accounts.google.com/signin/continue?sarp=1 ...'
    } as any);
    expect(ok).toBe(true);
  });

  it('does not trigger when message is unrelated 403', async () => {
    const mod = await import('../../../src/providers/auth/oauth-lifecycle.js');

    const ok = mod.shouldTriggerInteractiveOAuthRepair('antigravity', {
      statusCode: 403,
      message: 'HTTP 403: permission denied'
    } as any);
    expect(ok).toBe(false);
  });
});
