import { describe, expect, test } from '@jest/globals';

import {
  __unsafeResetRequestIdCounterForTests,
  __unsafeRequestIdCacheSize,
  __unsafeSweepRequestIdCaches,
  enhanceProviderRequestId,
  generateRequestIdentifiers,
  resolveEffectiveRequestId
} from '../../../src/server/utils/request-id-manager.js';

function currentNoonWindowKey(): string {
  const local = new Date();
  if (local.getHours() < 12) {
    local.setDate(local.getDate() - 1);
  }
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, '0');
  const dd = String(local.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

describe('request-id-manager', () => {
  test('provider request id sequence uses persistent total-window format: total-window', () => {
    __unsafeResetRequestIdCounterForTests({
      totalCount: 41,
      windowCount: 9,
      windowKey: currentNoonWindowKey()
    });

    const providerRequestId = generateRequestIdentifiers(undefined, {
      entryEndpoint: '/v1/responses',
      providerId: 'tabglm.key1',
      model: 'glm-5-turbo'
    }).providerRequestId;

    expect(providerRequestId).toMatch(
      /^openai-responses-tabglm\.key1-glm-5-turbo-\d{8}T\d{9}-42-10$/
    );
  });

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

  test('daily window counter resets when noon-window key changes', () => {
    __unsafeResetRequestIdCounterForTests({
      totalCount: 100,
      windowCount: 33,
      windowKey: '20000101'
    });

    const providerRequestId = generateRequestIdentifiers(undefined, {
      entryEndpoint: '/v1/messages',
      providerId: 'iflow.1-186',
      model: 'kimi-k2.5'
    }).providerRequestId;

    // windowKey 与当前 noon-window key 不一致时，应先 reset 今日计数再递增到 1。
    expect(providerRequestId).toMatch(
      /^anthropic-messages-iflow\.1-186-kimi-k2\.5-\d{8}T\d{9}-101-1$/
    );

    __unsafeSweepRequestIdCaches(Date.now() + 10 * 60 * 1000);
  });
});
