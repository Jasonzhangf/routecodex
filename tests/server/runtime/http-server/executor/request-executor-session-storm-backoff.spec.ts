import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  consumeSessionStormBackoffMs,
  isSessionStormBackoffCandidate,
  peekSessionStormBackoffWaitMs,
  resetSessionStormBackoffStateForTests,
} from '../../../../../src/server/runtime/http-server/executor/request-executor-session-storm-backoff';

describe('request-executor session storm backoff', () => {
  beforeEach(() => {
    resetSessionStormBackoffStateForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    resetSessionStormBackoffStateForTests();
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_MAX_MS;
  });

  test('treats router-direct protocol mismatch as deterministic storm candidate', () => {
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS = '8000';

    const error = new Error(
      'router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat'
    );

    expect(isSessionStormBackoffCandidate(error)).toBe(true);
    expect(consumeSessionStormBackoffMs('session:router-direct-protocol-mismatch', error)).toBe(1000);
    expect(peekSessionStormBackoffWaitMs('session:router-direct-protocol-mismatch')).toBe(1000);
  });
});
