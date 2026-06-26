import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  computeErrorActionBackoffDelayMs,
  describeErrorActionQueueContract,
  peekErrorActionBackoffConsecutiveForTests,
  peekErrorActionBackoffWaitMs,
  recordErrorActionBackoff,
  registerErrorActionQueueHook,
  resetErrorActionBackoff,
  resetErrorActionQueueStateForTests,
  waitErrorActionBackoffWithGate
} from '../../../../../src/server/runtime/http-server/executor/request-executor-error-action-queue';

describe('request-executor-error-action-queue', () => {
  beforeEach(() => {
    resetErrorActionQueueStateForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    resetErrorActionQueueStateForTests();
  });

  test('uses fixed 1s-2s-3s cycling delays', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(computeErrorActionBackoffDelayMs)).toEqual([
      1000,
      2000,
      3000,
      1000,
      2000,
      3000,
      1000
    ]);
  });

  test('describes unified contract for help and architecture map queries', () => {
    expect(describeErrorActionQueueContract()).toEqual({
      featureId: 'feature_id: error.backoff_action_queue',
      delaySequenceMs: [1000, 2000, 3000],
      blockingWait: true,
      maxWaiters: 64,
      categories: [
        'global_error',
        'session_storm',
        'provider_traffic_saturated',
        'servertool_followup'
      ],
      hookEvents: ['record', 'wait_start', 'wait_end']
    });
  });

  test('records by category and scope and emits hook events', () => {
    const events: unknown[] = [];
    const unregister = registerErrorActionQueueHook((event) => events.push(event));

    expect(recordErrorActionBackoff({
      category: 'session_storm',
      scopeKey: 'session:storm-1'
    })).toBe(1000);
    expect(recordErrorActionBackoff({
      category: 'session_storm',
      scopeKey: 'session:storm-1'
    })).toBe(2000);
    expect(peekErrorActionBackoffConsecutiveForTests({
      category: 'session_storm',
      scopeKey: 'session:storm-1'
    })).toBe(2);
    expect(peekErrorActionBackoffWaitMs({
      category: 'session_storm',
      scopeKey: 'session:storm-1'
    })).toBe(2000);
    expect(events).toEqual([
      expect.objectContaining({ type: 'record', delayMs: 1000, consecutive: 1 }),
      expect.objectContaining({ type: 'record', delayMs: 2000, consecutive: 2 })
    ]);

    unregister();
  });

  test('serializes blocking waits through the same category/scope gate', async () => {
    recordErrorActionBackoff({
      category: 'provider_traffic_saturated',
      scopeKey: 'runtime:busy'
    });

    const first = waitErrorActionBackoffWithGate({
      category: 'provider_traffic_saturated',
      scopeKey: 'runtime:busy'
    });
    const second = waitErrorActionBackoffWithGate({
      category: 'provider_traffic_saturated',
      scopeKey: 'runtime:busy'
    });

    await jest.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toBe(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBe(1000);
  });

  test('reset clears one category/scope without touching other categories', () => {
    recordErrorActionBackoff({
      category: 'session_storm',
      scopeKey: 'session:storm-1'
    });
    recordErrorActionBackoff({
      category: 'global_error',
      scopeKey: 'global:error'
    });

    resetErrorActionBackoff({
      category: 'session_storm',
      scopeKey: 'session:storm-1'
    });

    expect(peekErrorActionBackoffWaitMs({
      category: 'session_storm',
      scopeKey: 'session:storm-1'
    })).toBe(0);
    expect(peekErrorActionBackoffWaitMs({
      category: 'global_error',
      scopeKey: 'global:error'
    })).toBe(1000);
  });

  test('uses a fixed waiter cap without per-call env configuration', async () => {
    recordErrorActionBackoff({
      category: 'session_storm',
      scopeKey: 'session:busy'
    });

    const waiters = Array.from({ length: 64 }, () => waitErrorActionBackoffWithGate({
      category: 'session_storm',
      scopeKey: 'session:busy'
    }));

    await expect(waitErrorActionBackoffWithGate({
      category: 'session_storm',
      scopeKey: 'session:busy'
    })).rejects.toMatchObject({
      code: 'PROVIDER_TRAFFIC_SATURATED',
      details: expect.objectContaining({
        reason: 'error_action_waiter_overload',
        maxWaiters: 64
      })
    });

    await jest.advanceTimersByTimeAsync(64_000);
    await Promise.all(waiters);
  });
});
