import { describe, expect, test } from '@jest/globals';

import { applyErrorEvent, createInitialQuotaState } from '../../src/quota/quota-state.js';
import type { ErrorEventForQuota } from '../../src/quota/types.js';

const BASE_TIME = 1_700_000_000_000;

function buildEvent(partial: Partial<ErrorEventForQuota>): ErrorEventForQuota {
  return {
    providerKey: partial.providerKey ?? 'crs.key1.gpt-5.2-codex',
    code: partial.code ?? null,
    httpStatus: partial.httpStatus ?? null,
    fatal: partial.fatal ?? null,
    timestampMs: partial.timestampMs ?? BASE_TIME,
    resetAt: partial.resetAt ?? null,
    authIssue: partial.authIssue ?? null
  };
}

describe('quota-state backoff rules', () => {
  test('network errors trigger short cooldown but stay in pool for first hit', () => {
    const state = createInitialQuotaState('crs.key1.gpt-5.2-codex', undefined, BASE_TIME);
    const event = buildEvent({ code: 'ECONNRESET', timestampMs: BASE_TIME });
    const next = applyErrorEvent(state, event, BASE_TIME);
    expect(next.cooldownUntil).toBe(BASE_TIME + 3_000);
    expect(next.inPool).toBe(true);
    expect(next.cooldownKeepsPool).toBe(true);
    expect(next.reason).toBe('cooldown');
    expect(next.lastErrorSeries).toBe('ENET');
  });

  test('same transient error accumulates to second cooldown but stays in pool', () => {
    const state = createInitialQuotaState('crs.key1.gpt-5.2-codex', undefined, BASE_TIME);
    const first = applyErrorEvent(state, buildEvent({ code: 'ECONNRESET', timestampMs: BASE_TIME }), BASE_TIME);
    const secondAt = BASE_TIME + 1_000;
    const second = applyErrorEvent(
      first,
      buildEvent({ code: 'ECONNRESET', timestampMs: secondAt }),
      secondAt
    );
    expect(second.cooldownUntil).toBe(secondAt + 5_000);
    expect(second.inPool).toBe(true);
    expect(second.cooldownKeepsPool).toBe(true);
    expect(second.lastErrorSeries).toBe('ENET');
  });

  test('different transient error resets counter to first cooldown', () => {
    const state = createInitialQuotaState('crs.key1.gpt-5.2-codex', undefined, BASE_TIME);
    const first = applyErrorEvent(state, buildEvent({ code: 'ECONNRESET', timestampMs: BASE_TIME }), BASE_TIME);
    const secondAt = BASE_TIME + 1_000;
    const second = applyErrorEvent(first, buildEvent({ code: 'ETIMEDOUT', timestampMs: secondAt }), secondAt);
    expect(second.cooldownUntil).toBe(secondAt + 3_000);
    expect(second.inPool).toBe(true);
    expect(second.cooldownKeepsPool).toBe(true);
    expect(second.consecutiveErrorCount).toBe(1);
  });

  test('returning to an older transient error after a different one still counts as first hit', () => {
    const state = createInitialQuotaState('crs.key1.gpt-5.2-codex', undefined, BASE_TIME);
    const first = applyErrorEvent(state, buildEvent({ code: 'ECONNRESET', timestampMs: BASE_TIME }), BASE_TIME);
    const secondAt = BASE_TIME + 1_000;
    const second = applyErrorEvent(first, buildEvent({ code: 'ETIMEDOUT', timestampMs: secondAt }), secondAt);
    const thirdAt = BASE_TIME + 2_000;
    const third = applyErrorEvent(second, buildEvent({ code: 'ECONNRESET', timestampMs: thirdAt }), thirdAt);
    expect(third.cooldownUntil).toBe(thirdAt + 3_000);
    expect(third.inPool).toBe(true);
    expect(third.cooldownKeepsPool).toBe(true);
    expect(third.consecutiveErrorCount).toBe(1);
  });

  test('first error triggers base cooldown; different errors do not accumulate', () => {
    const state = createInitialQuotaState('crs.key1.gpt-5.2-codex', undefined, BASE_TIME);
    const first = applyErrorEvent(state, buildEvent({ code: 'HTTP_400', httpStatus: 400 }), BASE_TIME);
    expect(first.cooldownUntil).toBe(BASE_TIME + 3_000);
    expect(first.consecutiveErrorCount).toBe(1);

    const nextTime = BASE_TIME + 1_000;
    const second = applyErrorEvent(first, buildEvent({ code: 'HTTP_500', httpStatus: 500, timestampMs: nextTime }), nextTime);
    expect(second.consecutiveErrorCount).toBe(1);
    expect(second.lastErrorCode).toBe('HTTP_500');
  });

  test('generic error code falls back to HTTP status for error key', () => {
    const state = createInitialQuotaState('crs.key1.gpt-5.2-codex', undefined, BASE_TIME);
    const next = applyErrorEvent(state, buildEvent({ code: 'ERR_PROVIDER_FAILURE', httpStatus: 500 }), BASE_TIME);
    expect(next.lastErrorCode).toBe('HTTP_500');
  });
});
