import { describe, expect, jest, test, beforeEach, afterEach } from '@jest/globals';
import {
  peekErrorActionBackoffWaitMs,
  recordErrorActionBackoff,
  resetErrorActionBackoff,
  resetErrorActionBackoffByScopePrefix,
  resetErrorActionQueueStateForTests,
  waitErrorActionBackoffWithGate
} from '../../../../../src/server/runtime/http-server/executor/request-executor-error-action-queue';

const GLOBAL_ERROR_CATEGORY = 'global_error' as const;

describe('request-executor-global-error-backoff', () => {
  const scopeA = '5520|openai.key1.gpt-5.3-codex-low|upstream_transient';
  const scopeB = '5555|openai.key1.gpt-5.3-codex-low|upstream_transient';
  const scopeC = '5520|glm.key1.gpt-5.3-codex-low|upstream_transient';
  const scopeD = '5520|openai.key1.gpt-5.3-codex-low|status_429';

  beforeEach(() => {
    resetErrorActionQueueStateForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    resetErrorActionQueueStateForTests();
  });

  test('applies minimum 1s wait after first error in same scope', () => {
    const delayMs = recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA });
    expect(delayMs).toBe(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
  });

  test('cycles 1s to 2s to 3s for consecutive same-scope errors and resets on success', () => {
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(2000);
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(3000);
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(2000);
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(3000);

    resetErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA });
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(0);
  });

  test('does not accumulate delayed debt after the current backoff window elapses in same scope', () => {
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);

    jest.advanceTimersByTime(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(0);

    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(2000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(2000);
  });

  test('resets consecutive scoped errors after provider-scope success', () => {
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeD })).toBe(1000);
    resetErrorActionBackoffByScopePrefix({
      category: GLOBAL_ERROR_CATEGORY,
      scopePrefix: '5520|openai.key1.gpt-5.3-codex-low|'
    });

    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeD })).toBe(0);
  });

  test('isolates scopes by port / provider / error-code', () => {
    expect(recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeB })).toBe(0);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeC })).toBe(0);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeD })).toBe(0);
  });

  test('wait gate blocks only the same scope until timer elapses', async () => {
    recordErrorActionBackoff({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA });
    const waiting = waitErrorActionBackoffWithGate({
      category: GLOBAL_ERROR_CATEGORY,
      scopeKey: scopeA
    });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toBe(1000);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeA })).toBe(0);
    expect(peekErrorActionBackoffWaitMs({ category: GLOBAL_ERROR_CATEGORY, scopeKey: scopeB })).toBe(0);
  });
});
