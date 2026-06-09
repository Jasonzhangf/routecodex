import { describe, expect, jest, test, beforeEach, afterEach } from '@jest/globals';
import {
  peekScopedErrorBackoffWaitMs,
  recordScopedErrorBackoff,
  resetGlobalErrorBackoffStateForTests,
  resetScopedErrorBackoff,
  resetScopedErrorBackoffByProvider,
  waitScopedErrorBackoffWithGate
} from '../../../../../src/server/runtime/http-server/executor/request-executor-global-error-backoff';

describe('request-executor-global-error-backoff', () => {
  const scopeA = '5520|openai.key1.gpt-5.3-codex-low|upstream_transient';
  const scopeB = '5555|openai.key1.gpt-5.3-codex-low|upstream_transient';
  const scopeC = '5520|glm.key1.gpt-5.3-codex-low|upstream_transient';
  const scopeD = '5520|openai.key1.gpt-5.3-codex-low|status_429';

  beforeEach(() => {
    resetGlobalErrorBackoffStateForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    resetGlobalErrorBackoffStateForTests();
  });

  test('applies minimum 1s wait after first error in same scope', () => {
    const delayMs = recordScopedErrorBackoff(scopeA);
    expect(delayMs).toBe(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(1000);
  });

  test('uses exponential backoff for consecutive same-scope errors and resets on success', () => {
    expect(recordScopedErrorBackoff(scopeA)).toBe(1000);
    expect(recordScopedErrorBackoff(scopeA)).toBe(2000);
    expect(recordScopedErrorBackoff(scopeA)).toBe(4000);

    resetScopedErrorBackoff(scopeA);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(0);
  });

  test('does not accumulate delayed debt after the current backoff window elapses in same scope', () => {
    expect(recordScopedErrorBackoff(scopeA)).toBe(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(1000);

    jest.advanceTimersByTime(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(0);

    expect(recordScopedErrorBackoff(scopeA)).toBe(2000);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(2000);
  });

  test('resets consecutive scoped errors after provider-scope success', () => {
    expect(recordScopedErrorBackoff(scopeA)).toBe(1000);
    expect(recordScopedErrorBackoff(scopeD)).toBe(1000);
    resetScopedErrorBackoffByProvider('5520|openai.key1.gpt-5.3-codex-low|');

    expect(recordScopedErrorBackoff(scopeA)).toBe(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeD)).toBe(0);
  });

  test('isolates scopes by port / provider / error-code', () => {
    expect(recordScopedErrorBackoff(scopeA)).toBe(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeB)).toBe(0);
    expect(peekScopedErrorBackoffWaitMs(scopeC)).toBe(0);
    expect(peekScopedErrorBackoffWaitMs(scopeD)).toBe(0);
  });

  test('wait gate blocks only the same scope until timer elapses', async () => {
    recordScopedErrorBackoff(scopeA);
    const waiting = waitScopedErrorBackoffWithGate(scopeA);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toBe(1000);
    expect(peekScopedErrorBackoffWaitMs(scopeA)).toBe(0);
    expect(peekScopedErrorBackoffWaitMs(scopeB)).toBe(0);
  });
});
