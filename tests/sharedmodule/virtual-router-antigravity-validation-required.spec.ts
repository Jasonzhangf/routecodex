import { applyAntigravityRiskPolicyImpl } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-health.js';

describe('antigravity risk policy: VALIDATION_REQUIRED (403)', () => {
  it('treats VALIDATION_REQUIRED as Google verification required and only trips the affected runtimeKey', () => {
    const listProviderKeys = () => [
      'antigravity.test.gemini-3-pro-high',
      'antigravity.test.claude-sonnet-4-5-thinking',
      'antigravity.other.gemini-3-flash'
    ];

    const get = (providerKey: string) => ({
      providerKey,
      modelId: providerKey.split('.').slice(-1)[0]
    });

    const providerRegistry = {
      listProviderKeys,
      get
    } as any;

    const tripped: Array<{ key: string; reason: string; cooldownMs: number }> = [];
    const healthManager = {
      isAvailable: () => true,
      tripProvider: (key: string, reason: string, cooldownMs: number) => {
        tripped.push({ key, reason, cooldownMs });
      }
    } as any;

    const cooldowns: Array<{ key: string; cooldownMs: number | undefined }> = [];
    const markProviderCooldown = (providerKey: string, cooldownMs: number | undefined) => {
      cooldowns.push({ key: providerKey, cooldownMs });
    };

    applyAntigravityRiskPolicyImpl(
      {
        status: 403,
        code: 'HTTP_403',
        stage: 'provider.provider.http',
        message: 'HTTP 403: {"error":{"message":"VALIDATION_REQUIRED","validation_url":"https://accounts.google.com/signin/continue"}}',
        runtime: {
          providerId: 'antigravity',
          providerKey: 'antigravity.test.gemini-3-pro-high',
          target: {
            runtimeKey: 'antigravity.test',
            providerKey: 'antigravity.test.gemini-3-pro-high'
          }
        }
      } as any,
      providerRegistry,
      healthManager,
      markProviderCooldown
    );

    const trippedKeys = tripped.map((entry) => entry.key).sort();
    expect(trippedKeys).toEqual([
      'antigravity.test.claude-sonnet-4-5-thinking',
      'antigravity.test.gemini-3-pro-high'
    ]);

    expect(tripped.every((entry) => entry.reason === 'auth_verify')).toBe(true);
    expect(cooldowns.map((c) => c.key).sort()).toEqual(trippedKeys);
  });
});

