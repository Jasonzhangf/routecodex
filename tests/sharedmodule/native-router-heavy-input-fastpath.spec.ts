import { describe, expect, it, jest } from '@jest/globals';

describe('native router heavy-input fastpath wrapper', () => {
  it('parses native heavy-input decision payload and tags source', async () => {
    jest.resetModules();

    jest.unstable_mockModule(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-loader.js',
      () => ({
        loadNativeRouterHotpathBinding: () => ({
          decideHeavyInputFastpathJson: () =>
            JSON.stringify({
              estimatedTokens: 123456,
              shouldMark: true,
              reason: 'rough_estimate',
            }),
        }),
        resolveNativeModuleUrlFromEnv: () => undefined,
      }),
    );

    jest.unstable_mockModule(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-policy.js',
      () => ({
        isNativeDisabledByEnv: () => false,
        makeNativeRequiredError: (_capability: string, reason?: string) =>
          new Error(`native-required:${reason ?? 'unknown'}`),
      }),
    );

    const mod = await import(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath.js'
    );

    expect(mod.decideHeavyInputFastpath({ messages: [] }, {})).toEqual({
      estimatedTokens: 123456,
      shouldMark: true,
      reason: 'rough_estimate',
      source: 'native',
    });
  });
});
