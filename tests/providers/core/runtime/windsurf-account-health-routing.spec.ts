import { beforeAll, describe, expect, test, jest } from '@jest/globals';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf provider tests'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

let WindsurfChatProvider: any;

function createProvider(auth: Record<string, unknown> = { type: 'apikey', apiKey: 'devin-session-token$primary' }) {
  return new WindsurfChatProvider({
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: 'http://localhost:3003',
      model: 'gpt-5.4-medium',
      auth,
    },
  } as any, deps);
}

describe('Windsurf account health routing (RED before implementation)', () => {
  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  test('health api payload must expose quota snapshot (extra via overage + daily/weekly remaining)', async () => {
    const provider = createProvider();
    const snapshot = (provider as any).extractQuotaHealthFromUserStatusPayload({
      userStatus: {
        planStatus: {
          dailyQuotaRemainingPercent: 62,
          weeklyQuotaRemainingPercent: 41,
          overageBalanceMicros: 9000000,
        },
      },
    });
    expect(snapshot).toEqual(expect.objectContaining({
      hasExtraQuota: true,
      dailyRemainingPercent: 62,
      weeklyRemainingPercent: 41,
      remainingScore: 41,
      overageBalance: 9,
      exhausted: false,
      fetchedAt: expect.any(Number),
    }));
  });

  test('account ranking must prefer extra quota first, then higher remaining quota', async () => {
    const provider = createProvider();
    const ranked = (provider as any).rankManagedCredentialsByHealth([
      { alias: 'normal-high', apiKey: 'k1', health: { hasExtraQuota: false, remainingScore: 90 } },
      { alias: 'extra-low', apiKey: 'k2', health: { hasExtraQuota: true, remainingScore: 20 } },
      { alias: 'extra-high', apiKey: 'k3', health: { hasExtraQuota: true, remainingScore: 70 } },
      { alias: 'unknown', apiKey: 'k4', health: null },
    ]);

    expect(ranked.map((entry: any) => entry.alias)).toEqual([
      'extra-high',
      'extra-low',
      'normal-high',
      'unknown',
    ]);
  });

  test('session sticky must pin healthy key until quota exhausted', async () => {
    const provider = createProvider();
    const sessionKey = 'sess-sticky-001';
    const first = (provider as any).selectManagedCredentialForSession(sessionKey, [
      { alias: 'extra-main', apiKey: 'k-main', health: { hasExtraQuota: true, remainingScore: 58, exhausted: false } },
      { alias: 'backup', apiKey: 'k-backup', health: { hasExtraQuota: false, remainingScore: 99, exhausted: false } },
    ]);
    const second = (provider as any).selectManagedCredentialForSession(sessionKey, [
      { alias: 'extra-main', apiKey: 'k-main', health: { hasExtraQuota: true, remainingScore: 27, exhausted: false } },
      { alias: 'backup', apiKey: 'k-backup', health: { hasExtraQuota: false, remainingScore: 99, exhausted: false } },
    ]);

    expect(first.apiKey).toBe('k-main');
    expect(second.apiKey).toBe('k-main');
  });

  test('selected healthiest account must remain pinned even if a later ranking would prefer another account', async () => {
    const provider = createProvider();
    const sessionKey = 'sess-healthiest-pin-001';
    const first = (provider as any).selectManagedCredentialForSession(sessionKey, [
      { alias: 'extra-main', apiKey: 'k-main', health: { hasExtraQuota: true, remainingScore: 30, exhausted: false } },
      { alias: 'normal-backup', apiKey: 'k-backup', health: { hasExtraQuota: false, remainingScore: 99, exhausted: false } },
    ]);
    const second = (provider as any).selectManagedCredentialForSession(sessionKey, [
      { alias: 'extra-main', apiKey: 'k-main', health: { hasExtraQuota: false, remainingScore: 10, exhausted: false } },
      { alias: 'normal-backup', apiKey: 'k-backup', health: { hasExtraQuota: true, remainingScore: 99, exhausted: false } },
    ]);

    expect(first.apiKey).toBe('k-main');
    expect(second.apiKey).toBe('k-main');
  });

  test('routing state key must be resolved from request session fields before fallback default', async () => {
    const provider = createProvider();
    expect((provider as any).resolveWindsurfSessionStateKeyFromRequest({
      body: { conversation_id: 'conv-001' },
    })).toBe('conv-001');
    expect((provider as any).resolveWindsurfSessionStateKeyFromRequest({
      body: { sessionId: 'sess-xyz' },
    })).toBe('sess-xyz');
    expect((provider as any).resolveWindsurfSessionStateKeyFromRequest({
      body: {},
    })).toBe('provider-default-session');
  });

  test('permission_denied text alone must not be treated as auth failure', async () => {
    const provider = createProvider();
    const isAuthFailure = (provider as any).isWindsurfAuthFailure({
      message: 'upstream permission_denied for unrelated local runtime gate',
      status: 502,
    });
    expect(isAuthFailure).toBe(false);
  });

  test('provider-local concurrency capacity must track available healthy accounts', async () => {
    const provider = createProvider();
    const cap = (provider as any).computeAccountConcurrencyCapacity([
      { alias: 'a1', health: { exhausted: false } },
      { alias: 'a2', health: { exhausted: true } },
      { alias: 'a3', health: { exhausted: false } },
    ]);
    expect(cap).toBe(2);
  });

  test('account health probe must not refresh on every request after startup cache exists', async () => {
    const provider = createProvider({
      type: 'apikey',
      rawType: 'windsurf-account',
      entries: [
        { alias: 'ws-extra', apiKey: 'devin-session-token$extra' },
        { alias: 'ws-normal', apiKey: 'devin-session-token$normal' },
      ],
    });
    const fetchSpy = jest.spyOn(provider as any, 'fetchWindsurfUserStatusForHealth')
      .mockResolvedValueOnce({ hasExtraQuota: true, remainingScore: 60, exhausted: false, fetchedAt: Date.now() - 3_600_000 })
      .mockResolvedValueOnce({ hasExtraQuota: false, remainingScore: 90, exhausted: false, fetchedAt: Date.now() - 3_600_000 });
    const managed = await (provider as any).readManagedWindsurfAuthConfigDetailed();

    const first = await (provider as any).selectWindsurfAccount(managed);
    const second = await (provider as any).selectWindsurfAccount(managed);

    expect(first.accountAlias).toBe('ws-extra');
    expect(second.accountAlias).toBe('ws-extra');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
