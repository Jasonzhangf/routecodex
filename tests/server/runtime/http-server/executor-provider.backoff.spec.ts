import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { waitBeforeRetry } from '../../../../src/server/runtime/http-server/executor-provider.js';

describe('executor-provider waitBeforeRetry', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
    delete process.env.RCC_429_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
    delete process.env.RCC_429_BACKOFF_MAX_MS;
    delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
    delete process.env.RCC_PROVIDER_RETRY_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS;
    delete process.env.RCC_PROVIDER_RETRY_BACKOFF_MAX_MS;
    delete process.env.ROUTECODEX_NETWORK_RETRY_BACKOFF_BASE_MS;
    delete process.env.RCC_NETWORK_RETRY_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_NETWORK_RETRY_BACKOFF_MAX_MS;
    delete process.env.RCC_NETWORK_RETRY_BACKOFF_MAX_MS;
  });

  it('uses exponential backoff for HTTP 429', async () => {
    jest.useFakeTimers();
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const err = Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429
    });

    const pending = waitBeforeRetry(err, { attempt: 3 });

    expect(timerSpy).toHaveBeenCalled();
    const delay = timerSpy.mock.calls.at(-1)?.[1];
    expect(delay).toBe(4000);

    jest.runOnlyPendingTimers();
    await pending;
    timerSpy.mockRestore();
  });

  it('honors Retry-After header when larger than exponential delay', async () => {
    jest.useFakeTimers();
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const err = Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429,
      response: {
        headers: {
          'retry-after': '8'
        }
      }
    });

    const pending = waitBeforeRetry(err, { attempt: 1 });

    expect(timerSpy).toHaveBeenCalled();
    const delay = timerSpy.mock.calls.at(-1)?.[1];
    expect(delay).toBe(8000);

    jest.runOnlyPendingTimers();
    await pending;
    timerSpy.mockRestore();
  });

  it('uses exponential backoff for transport errors', async () => {
    jest.useFakeTimers();
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const err = Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET'
    });

    const pending = waitBeforeRetry(err, { attempt: 4 });

    expect(timerSpy).toHaveBeenCalled();
    const delay = timerSpy.mock.calls.at(-1)?.[1];
    expect(delay).toBe(4000);

    jest.runOnlyPendingTimers();
    await pending;
    timerSpy.mockRestore();
  });

  it('uses generic exponential backoff for non-429 retries (single-provider pool)', async () => {
    jest.useFakeTimers();
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const err = Object.assign(new Error('HTTP 500: upstream unavailable'), {
      statusCode: 500
    });

    const pending = waitBeforeRetry(err, { attempt: 4 });

    expect(timerSpy).toHaveBeenCalled();
    const delay = timerSpy.mock.calls.at(-1)?.[1];
    expect(delay).toBe(6400);

    jest.runOnlyPendingTimers();
    await pending;
    timerSpy.mockRestore();
  });
});
