import { buildProviderProfiles } from './profile-builder.js';

describe('buildProviderProfiles streaming precedence', () => {
  const targetKey = 'ali-coding-plan.key1.glm-5';
  const baseRuntime = {
    runtimeKey: 'ali-coding-plan.key1',
    providerId: 'ali-coding-plan',
    keyAlias: 'key1',
    providerType: 'anthropic',
    endpoint: 'https://example.test/anthropic',
    auth: { type: 'apiKey' as const, secretRef: 'ali-coding-plan.key1' },
    outboundProfile: 'anthropic-messages',
    processMode: 'chat' as const
  };

  it('prefers explicit provider-level never over model-level always', () => {
    const { profiles, targetRuntime } = buildProviderProfiles(
      new Set([targetKey]),
      {
        'ali-coding-plan.key1': {
          ...baseRuntime,
          streaming: 'never',
          modelStreaming: { 'glm-5': 'always' }
        }
      }
    );

    expect(profiles[targetKey]?.streaming).toBe('never');
    expect(targetRuntime[targetKey]?.streaming).toBe('never');
  });

  it('prefers explicit provider-level always over model-level never', () => {
    const { profiles, targetRuntime } = buildProviderProfiles(
      new Set([targetKey]),
      {
        'ali-coding-plan.key1': {
          ...baseRuntime,
          streaming: 'always',
          modelStreaming: { 'glm-5': 'never' }
        }
      }
    );

    expect(profiles[targetKey]?.streaming).toBe('always');
    expect(targetRuntime[targetKey]?.streaming).toBe('always');
  });

  it('still allows model-level streaming when provider-level is auto', () => {
    const { profiles, targetRuntime } = buildProviderProfiles(
      new Set([targetKey]),
      {
        'ali-coding-plan.key1': {
          ...baseRuntime,
          streaming: 'auto',
          modelStreaming: { 'glm-5': 'never' }
        }
      }
    );

    expect(profiles[targetKey]?.streaming).toBe('never');
    expect(targetRuntime[targetKey]?.streaming).toBe('never');
  });
});
