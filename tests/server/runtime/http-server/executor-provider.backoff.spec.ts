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

  it('returns immediately for HTTP 429', async () => {
    const err = Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429
    });

    await expect(waitBeforeRetry(err, { attempt: 3 })).resolves.toBe(0);
  });

  it('ignores upstream retry-after details and returns immediately', async () => {
    const err = Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429,
      response: {
        headers: {
          'retry-after': '8'
        }
      }
    });

    await expect(waitBeforeRetry(err, { attempt: 1 })).resolves.toBe(0);
  });

  it('returns immediately for transport errors', async () => {
    const err = Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET'
    });

    await expect(waitBeforeRetry(err, { attempt: 4 })).resolves.toBe(0);
  });

  it('returns immediately for non-429 retries (single-provider pool)', async () => {
    const err = Object.assign(new Error('HTTP 500: upstream unavailable'), {
      statusCode: 500
    });

    await expect(waitBeforeRetry(err, { attempt: 4 })).resolves.toBe(0);
  });

  it('does not keep attempt-based wait sequencing', async () => {
    const err = Object.assign(new Error('HTTP 500: upstream unavailable'), {
      statusCode: 500
    });

    await expect(waitBeforeRetry(err, { attempt: 2 })).resolves.toBe(0);
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
