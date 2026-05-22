import { jest } from '@jest/globals';

describe('provider-quota-daemon snapshot weekly windsurf migration', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('expands persisted weekly blacklist from one model to the whole alias family on reload', async () => {
    const nowMs = Date.now();
    const blacklistUntil = nowMs + 24 * 60 * 60_000;
    const snapshot = {
      providers: {
        'windsurf.ws-pro-1.gpt-5.4-medium': {
          providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium',
          inPool: false,
          reason: 'blacklist',
          authType: 'apikey',
          windowStartMs: nowMs,
          requestsThisWindow: 0,
          tokensThisWindow: 0,
          totalTokensUsed: 0,
          cooldownUntil: null,
          blacklistUntil,
          lastErrorSeries: 'E429',
          lastErrorCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
          lastErrorAtMs: nowMs + 123,
          consecutiveErrorCount: 1
        }
      }
    };

    jest.unstable_mockModule('../../../../src/manager/quota/provider-quota-store.js', () => ({
      loadProviderQuotaSnapshot: jest.fn(async () => snapshot),
      saveProviderQuotaSnapshot: jest.fn(async () => {}),
      sanitizeQuotaStateForSnapshot: (state: unknown) => state
    }));

    const { loadProviderQuotaStates } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.snapshot.js');

    const staticConfigs = new Map<string, any>([
      ['windsurf.ws-pro-1', { authType: 'apikey' }],
      ['windsurf.ws-pro-1.gpt-5.4-medium', { authType: 'apikey' }],
      ['windsurf.ws-pro-1.gpt-5.4-high', { authType: 'apikey' }],
      ['windsurf.ws-pro-1.gpt-5.3-codex-low', { authType: 'apikey' }],
      ['windsurf.ws-pro-2.gpt-5.4-medium', { authType: 'apikey' }]
    ]);

    const { quotaStates, needsPersist } = await loadProviderQuotaStates({ staticConfigs });

    expect(needsPersist).toBe(true);
    expect(quotaStates.get('windsurf.ws-pro-1')?.reason).toBe('blacklist');
    expect(quotaStates.get('windsurf.ws-pro-1.gpt-5.4-high')?.reason).toBe('blacklist');
    expect(quotaStates.get('windsurf.ws-pro-1.gpt-5.3-codex-low')?.reason).toBe('blacklist');
    expect(quotaStates.get('windsurf.ws-pro-2.gpt-5.4-medium')?.reason).toBe('ok');
    expect(quotaStates.get('windsurf.ws-pro-1.gpt-5.4-high')?.blacklistUntil).toBe(blacklistUntil);
  });
});
