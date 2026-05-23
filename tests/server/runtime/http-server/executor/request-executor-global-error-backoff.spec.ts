import { describe, expect, jest, test, beforeEach, afterEach } from '@jest/globals';
import {
  peekGlobalErrorBackoffWaitMs,
  recordGlobalErrorBackoff,
  resetGlobalErrorBackoffStateForTests,
  resetGlobalErrorBackoff,
  waitGlobalErrorBackoffWithGate
} from '../../../../../src/server/runtime/http-server/executor/request-executor-global-error-backoff';

describe('request-executor-global-error-backoff', () => {
  beforeEach(() => {
    resetGlobalErrorBackoffStateForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    resetGlobalErrorBackoffStateForTests();
  });

  test('applies minimum 1s wait after first error', () => {
    const delayMs = recordGlobalErrorBackoff(new Error('first error'));
    expect(delayMs).toBe(1000);
    expect(peekGlobalErrorBackoffWaitMs()).toBe(1000);
  });

  test('uses exponential backoff for consecutive errors and resets on success', () => {
    expect(recordGlobalErrorBackoff(new Error('e1'))).toBe(1000);
    expect(recordGlobalErrorBackoff(new Error('e2'))).toBe(2000);
    expect(recordGlobalErrorBackoff(new Error('e3'))).toBe(4000);

    resetGlobalErrorBackoff();
    expect(peekGlobalErrorBackoffWaitMs()).toBe(0);
  });

  test('does not accumulate delayed debt after the current backoff window elapses', () => {
    expect(recordGlobalErrorBackoff(new Error('e1'))).toBe(1000);
    expect(peekGlobalErrorBackoffWaitMs()).toBe(1000);

    jest.advanceTimersByTime(1000);
    expect(peekGlobalErrorBackoffWaitMs()).toBe(0);

    expect(recordGlobalErrorBackoff(new Error('e2'))).toBe(2000);
    expect(peekGlobalErrorBackoffWaitMs()).toBe(2000);
  });

  test('resets consecutive global errors after non-error request completion', () => {
    expect(recordGlobalErrorBackoff(new Error('e1'))).toBe(1000);
    resetGlobalErrorBackoff();

    expect(recordGlobalErrorBackoff(new Error('e2'))).toBe(1000);
    expect(peekGlobalErrorBackoffWaitMs()).toBe(1000);
  });

  test('wait gate blocks until timer elapses', async () => {
    recordGlobalErrorBackoff(new Error('e1'));
    const waiting = waitGlobalErrorBackoffWithGate();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toBe(1000);
    expect(peekGlobalErrorBackoffWaitMs()).toBe(0);
  });
});
