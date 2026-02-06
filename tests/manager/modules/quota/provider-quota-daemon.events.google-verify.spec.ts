import { describe, expect, it, jest } from '@jest/globals';

describe('provider-quota-daemon google verify URL extraction', () => {
  it('prefers accounts verify URL when message also contains support link', async () => {
    jest.resetModules();

    const appendProviderErrorEvent = jest.fn(async () => {});
    const saveProviderQuotaSnapshot = jest.fn(async () => {});

    jest.unstable_mockModule('../../../../src/manager/quota/provider-quota-store.js', () => ({
      appendProviderErrorEvent,
      saveProviderQuotaSnapshot
    }));

    const { handleProviderQuotaErrorEvent } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.events.js');

    const providerKey = 'antigravity.antonsoltan.gemini-2.5-pro';
    const quotaStates = new Map<string, any>();
    const staticConfigs = new Map<string, any>();
    staticConfigs.set(providerKey, { authType: 'oauth', priorityTier: 100 });
    const ctx: any = {
      quotaStates,
      staticConfigs,
      quotaRoutingEnabled: true,
      modelBackoff: {
        recordCapacity429: () => {},
        getActiveCooldownUntil: () => null
      },
      schedulePersist: () => {},
      toSnapshotObject: () => Object.fromEntries(quotaStates)
    };

    const event: any = {
      status: 403,
      code: 'HTTP_403',
      stage: 'provider.provider.http',
      message:
        'HTTP 403: {"error":{"code":403,"message":"To continue, verify your account at\\n\\nhttps://accounts.google.com/signin/continue?sarp=1&scc=1&authuser\\n\\nLearn more\\n\\nhttps://support.google.com/accounts?p=al_alert\\n"}}',
      runtime: {
        providerKey,
        target: { providerKey }
      }
    };

    await handleProviderQuotaErrorEvent(ctx, event);

    expect(quotaStates.size).toBeGreaterThan(0);
    const next = quotaStates.get(providerKey) ?? Array.from(quotaStates.values())[0];
    expect(next?.reason).toBe('authVerify');
    expect(next?.authIssue?.kind).toBe('google_account_verification');
    expect(String(next?.authIssue?.url || '')).toContain('accounts.google.com/signin/continue');
    expect(String(next?.authIssue?.url || '')).not.toContain('support.google.com/accounts?p=al_alert');
  });
});
