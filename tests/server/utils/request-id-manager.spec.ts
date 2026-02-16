import { describe, expect, test } from '@jest/globals';

import {
  __unsafeRequestIdCacheSize,
  __unsafeSweepRequestIdCaches,
  enhanceProviderRequestId,
  generateRequestIdentifiers,
  resolveEffectiveRequestId
} from '../../../src/server/utils/request-id-manager.js';

describe('request-id-manager', () => {
  test('enhanced ids remain resolvable and aliases can be swept', () => {
    const base = generateRequestIdentifiers(undefined, {
      entryEndpoint: '/v1/messages',
      providerId: 'iflow.1-186',
      model: 'kimi-k2.5'
    }).providerRequestId;

    const enhanced = enhanceProviderRequestId(base, {
      providerId: 'deepseek-web.1',
      model: 'deepseek-chat'
    });

    expect(enhanced).not.toBe(base);
    expect(resolveEffectiveRequestId(base)).toBe(enhanced);

    __unsafeSweepRequestIdCaches(Date.now() + 10 * 60 * 1000);

    expect(resolveEffectiveRequestId(base)).toBe(base);
    const size = __unsafeRequestIdCacheSize();
    expect(size.aliases).toBe(0);
  });

  test('provider sequence cache is capped', () => {
    for (let i = 0; i < 2200; i += 1) {
      generateRequestIdentifiers(undefined, {
        entryEndpoint: '/v1/messages',
        providerId: `provider-${i}`,
        model: 'model-x'
      });
    }

    const size = __unsafeRequestIdCacheSize();
    expect(size.seqKeys).toBeLessThanOrEqual(2048);

    __unsafeSweepRequestIdCaches(Date.now() + 10 * 60 * 1000);
  });
});
