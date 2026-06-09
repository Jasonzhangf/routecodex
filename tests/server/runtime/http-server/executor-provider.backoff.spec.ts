import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { waitBeforeRetry } from '../../../../src/server/runtime/http-server/executor-provider.js';
import {
  resetErrorActionQueueStateForTests
} from '../../../../src/server/runtime/http-server/executor/request-executor-error-action-queue.js';

describe('executor-provider waitBeforeRetry', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetErrorActionQueueStateForTests();
  });

  it('uses unified 1s backoff for HTTP 429', async () => {
    jest.useFakeTimers();
    const err = Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429
    });

    const pending = waitBeforeRetry(err, { attempt: 3 });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(1000);
  });

  it('uses unified backoff for errors carrying upstream retry-after details', async () => {
    jest.useFakeTimers();
    const err = Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429,
      response: {
        headers: {
          'retry-after': '8'
        }
      }
    });

    const pending = waitBeforeRetry(err, { attempt: 1 });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(1000);
  });

  it('uses unified 1s backoff for transport errors', async () => {
    jest.useFakeTimers();
    const err = Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET'
    });

    const pending = waitBeforeRetry(err, { attempt: 4 });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(1000);
  });

  it('uses unified 1s backoff for non-429 retries (single-provider pool)', async () => {
    jest.useFakeTimers();
    const err = Object.assign(new Error('HTTP 500: upstream unavailable'), {
      statusCode: 500
    });

    const pending = waitBeforeRetry(err, { attempt: 4 });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(1000);
  });

  it('keeps fixed sequence across attempts without per-call configuration', async () => {
    jest.useFakeTimers();
    const err = Object.assign(new Error('HTTP 500: upstream unavailable'), {
      statusCode: 500
    });

    const pending = waitBeforeRetry(err, { attempt: 2 });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(1000);
  });

  it('fails fast when abort listener registration fails instead of silently waiting for timeout', async () => {
    const err = Object.assign(new Error('HTTP 500: upstream unavailable'), {
      statusCode: 500
    });
    const signal = {
      aborted: false,
      addEventListener: () => {
        throw Object.assign(new Error('abort listener unavailable'), { code: 'ABORT_LISTENER_UNAVAILABLE' });
      },
      removeEventListener: jest.fn()
    } as unknown as AbortSignal;

    await expect(waitBeforeRetry(err, { attempt: 1, signal })).rejects.toMatchObject({
      code: 'ABORT_LISTENER_UNAVAILABLE'
    });
  });
});
