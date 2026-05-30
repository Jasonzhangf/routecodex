import { describe, expect, test, jest } from '@jest/globals';
import {
  WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG,
  isWindsurfCascadeBusyError,
  buildWindsurfCascadeBusyError,
  resolveWindsurfCascadeBusyDelayMs,
  executeWindsurfCascadeBusyRetry,
} from '../../../../src/providers/core/runtime/windsurf/cascade-continuation-block.ts';

describe('isWindsurfCascadeBusyError', () => {
  test('detects WINDSURF_CASCADE_BUSY code on plain Error', () => {
    const err = Object.assign(new Error('something'), { code: 'WINDSURF_CASCADE_BUSY' });
    expect(isWindsurfCascadeBusyError(err)).toBe(true);
  });

  test('detects busy pattern in message string', () => {
    const err = new Error('executor is not idle: CASCADE_RUN_STATUS_RUNNING');
    expect(isWindsurfCascadeBusyError(err)).toBe(true);
  });

  test('returns false for unrelated errors', () => {
    const err = new Error('network timeout');
    expect(isWindsurfCascadeBusyError(err)).toBe(false);
  });

  test('returns false for non-Error values', () => {
    expect(isWindsurfCascadeBusyError(null)).toBe(false);
    expect(isWindsurfCascadeBusyError(undefined)).toBe(false);
    expect(isWindsurfCascadeBusyError('busy')).toBe(false);
  });
});

describe('buildWindsurfCascadeBusyError', () => {
  test('creates error with correct fields', () => {
    const err = buildWindsurfCascadeBusyError(new Error('original'));
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('WINDSURF_CASCADE_BUSY');
    expect((err as any).status).toBe(429);
    expect((err as any).retryable).toBe(true);
    expect((err as any).rateLimitKind).toBe('short_lived');
  });

  test('preserves original error message', () => {
    const err = buildWindsurfCascadeBusyError(new Error('executor is not idle'));
    expect(err.message).toBe('executor is not idle');
  });

  test('handles non-Error input', () => {
    const err = buildWindsurfCascadeBusyError('string error');
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('WINDSURF_CASCADE_BUSY');
  });
});

describe('resolveWindsurfCascadeBusyDelayMs', () => {
  test('returns backoff from config array', () => {
    expect(resolveWindsurfCascadeBusyDelayMs(0)).toBe(1000);
    expect(resolveWindsurfCascadeBusyDelayMs(1)).toBe(2000);
    expect(resolveWindsurfCascadeBusyDelayMs(2)).toBe(4000);
    expect(resolveWindsurfCascadeBusyDelayMs(3)).toBe(4000);
  });

  test('returns last backoff for overflow attempts', () => {
    expect(resolveWindsurfCascadeBusyDelayMs(10)).toBe(4000);
  });

  test('respects custom config', () => {
    const config = { maxRetries: 2, backoffsMs: [100, 200] };
    expect(resolveWindsurfCascadeBusyDelayMs(0, config)).toBe(100);
    expect(resolveWindsurfCascadeBusyDelayMs(1, config)).toBe(200);
    expect(resolveWindsurfCascadeBusyDelayMs(5, config)).toBe(200);
  });
});

describe('executeWindsurfCascadeBusyRetry', () => {
  const ctx = { cascadeId: 'c1', sessionId: 's1' };
  const noopLog = jest.fn();

  test('returns immediately on first success', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const sleep = jest.fn();
    await executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log: noopLog });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('retries on busy error and succeeds', async () => {
    const busyErr = Object.assign(new Error('CASCADE_RUN_STATUS_RUNNING'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log: noopLog });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  test('throws non-busy errors immediately', async () => {
    const send = jest.fn().mockRejectedValue(new Error('auth failed'));
    const sleep = jest.fn();
    await expect(
      executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log: noopLog }),
    ).rejects.toThrow('auth failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('exhausts retries and throws WINDSURF_CASCADE_BUSY', async () => {
    const busyErr = Object.assign(new Error('not idle'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn().mockRejectedValue(busyErr);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const config = { maxRetries: 2, backoffsMs: [100, 200] };
    await expect(
      executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log: noopLog, config }),
    ).rejects.toMatchObject({ code: 'WINDSURF_CASCADE_BUSY', status: 429 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('uses correct backoff sequence', async () => {
    const busyErr = Object.assign(new Error('busy'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn()
      .mockRejectedValueOnce(busyErr)
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log: noopLog });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  test('logs each retry attempt', async () => {
    const busyErr = Object.assign(new Error('busy'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const log = jest.fn();
    await executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log });
    expect(log).toHaveBeenCalledWith('cascade.busy.retry', {
      cascadeId: 'c1',
      sessionId: 's1',
      attempt: 1,
      delayMs: 1000,
    });
  });
});


describe('executeWindsurfCascadeBusyRetry — trajectory polling (RED)', () => {
  const ctx = { cascadeId: 'c1', sessionId: 's1' };
  const noopLog = jest.fn();

  test('RED: calls pollIdle on busy and waits for idle before retrying send', async () => {
    const busyErr = Object.assign(new Error('CASCADE_RUN_STATUS_RUNNING'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);
    const pollIdle = jest.fn()
      .mockResolvedValueOnce({ idle: false })
      .mockResolvedValueOnce({ idle: true });
    const sleep = jest.fn().mockResolvedValue(undefined);
    await executeWindsurfCascadeBusyRetry(ctx, {
      sendMessage: send,
      sleep,
      log: noopLog,
      pollIdle,
      config: { maxRetries: 4, backoffsMs: [1000], totalWaitMs: 120_000, pollIntervalMs: 100 },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(pollIdle).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  test('RED: waits per-attempt then retries until maxRetries exhausted', async () => {
    const busyErr = Object.assign(new Error('not idle'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn().mockRejectedValue(busyErr);
    const pollIdle = jest.fn().mockResolvedValue({ idle: false });
    const sleep = jest.fn().mockResolvedValue(undefined);
    const config = { maxRetries: 3, backoffsMs: [100], perAttemptWaitMs: 200, pollIntervalMs: 50 };
    await expect(
      executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log: noopLog, pollIdle, config }),
    ).rejects.toMatchObject({ code: 'WINDSURF_CASCADE_BUSY', status: 429 });
    // 4 attempts (0..3), each polls for 200ms at 50ms interval = 4 polls per attempt = 16 total sleeps
    expect(send).toHaveBeenCalledTimes(4);
    expect(pollIdle.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(sleep).toHaveBeenCalledTimes(16);
  });

  test('RED: logs cascade.busy.wait_idle with poll details', async () => {
    const busyErr = Object.assign(new Error('busy'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);
    const pollIdle = jest.fn().mockResolvedValue({ idle: true });
    const log = jest.fn();
    await executeWindsurfCascadeBusyRetry(ctx, {
      sendMessage: send,
      sleep: jest.fn(),
      log,
      pollIdle,
      config: { maxRetries: 4, backoffsMs: [1000], totalWaitMs: 120_000, pollIntervalMs: 100 },
    });
    expect(log).toHaveBeenCalledWith('cascade.busy.wait_idle', expect.objectContaining({
      cascadeId: 'c1',
      sessionId: 's1',
    }));
  });

  test('RED: totalWaitMs defaults to 120000 (2 minutes)', async () => {
    const cfg = WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG;
    expect(cfg.totalWaitMs).toBe(120_000);
    expect(cfg.pollIntervalMs).toBe(1_000);
  });

  test('RED: falls back to blind sleep when pollIdle is not provided', async () => {
    const busyErr = Object.assign(new Error('busy'), { code: 'WINDSURF_CASCADE_BUSY' });
    const send = jest.fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await executeWindsurfCascadeBusyRetry(ctx, { sendMessage: send, sleep, log: noopLog });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
