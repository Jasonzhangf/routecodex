import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  __unsafeResetRequestIdCounterForTests,
  __unsafeRequestIdCacheSize,
  __unsafeSweepRequestIdCaches,
  enhanceProviderRequestId,
  generateRequestIdentifiers,
  resolveEffectiveRequestId
} from '../../../src/server/utils/request-id-manager.js';

function currentLocalDayWindowKey(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

describe('request-id-manager', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('provider request id sequence uses persistent total-window format: total-window', () => {
    __unsafeResetRequestIdCounterForTests({
      totalCount: 41,
      windowCount: 9,
      windowKey: currentLocalDayWindowKey()
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
      providerId: 'glm.1-186',
      model: 'kimi-k2.5'
    }).providerRequestId;

    const enhanced = enhanceProviderRequestId(base, {
      providerId: 'provider-a.1',
      model: 'model-a'
    });

    expect(enhanced).not.toBe(base);
    expect(resolveEffectiveRequestId(base)).toBe(enhanced);

    __unsafeSweepRequestIdCaches(Date.now() + 10 * 60 * 1000);

    expect(resolveEffectiveRequestId(base)).toBe(base);
    const size = __unsafeRequestIdCacheSize();
    expect(size.aliases).toBe(0);
  });

  test('daily window counter does not reset at local noon', () => {
    const beforeNoon = new Date(2026, 6, 10, 11, 59, 0, 0);
    const afterNoon = new Date(2026, 6, 10, 12, 1, 0, 0);
    jest.useFakeTimers().setSystemTime(beforeNoon);
    __unsafeResetRequestIdCounterForTests({
      totalCount: 100,
      windowCount: 33,
      windowKey: currentLocalDayWindowKey(beforeNoon)
    });

    jest.setSystemTime(afterNoon);
    const providerRequestId = generateRequestIdentifiers(undefined, {
      entryEndpoint: '/v1/messages',
      providerId: 'glm.1-186',
      model: 'kimi-k2.5'
    }).providerRequestId;

    expect(providerRequestId).toMatch(
      /^anthropic-messages-glm\.1-186-kimi-k2\.5-\d{8}T\d{9}-101-34$/
    );

    __unsafeSweepRequestIdCaches(Date.now() + 10 * 60 * 1000);
  });

  test('daily window counter resets at local midnight', () => {
    const beforeMidnight = new Date(2026, 6, 10, 23, 59, 0, 0);
    const afterMidnight = new Date(2026, 6, 11, 0, 1, 0, 0);
    jest.useFakeTimers().setSystemTime(beforeMidnight);
    __unsafeResetRequestIdCounterForTests({
      totalCount: 100,
      windowCount: 33,
      windowKey: currentLocalDayWindowKey(beforeMidnight)
    });

    jest.setSystemTime(afterMidnight);
    const providerRequestId = generateRequestIdentifiers(undefined, {
      entryEndpoint: '/v1/messages',
      providerId: 'glm.1-186',
      model: 'kimi-k2.5'
    }).providerRequestId;

    expect(providerRequestId).toMatch(
      /^anthropic-messages-glm\.1-186-kimi-k2\.5-\d{8}T\d{9}-101-1$/
    );

    __unsafeSweepRequestIdCaches(Date.now() + 10 * 60 * 1000);
  });
});
