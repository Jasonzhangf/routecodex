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
  });

  test('treats any surfaced error as storm candidate and cycles through unified 1s-2s-3s waits', () => {
    const error = new Error(
      'router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat'
    );

    expect(isSessionStormBackoffCandidate(error)).toBe(true);
    expect(consumeSessionStormBackoffMs('session:any-error', error)).toBe(1000);
    jest.setSystemTime(new Date('2026-06-09T00:00:01.000Z'));
    expect(consumeSessionStormBackoffMs('session:any-error', error)).toBe(2000);
    jest.setSystemTime(new Date('2026-06-09T00:00:03.000Z'));
    expect(consumeSessionStormBackoffMs('session:any-error', error)).toBe(3000);
    jest.setSystemTime(new Date('2026-06-09T00:00:06.000Z'));
    expect(consumeSessionStormBackoffMs('session:any-error', error)).toBe(1000);
    expect(peekSessionStormBackoffWaitMs('session:any-error')).toBe(1000);
  });

  test('routes hard-block candidates through the unified queue', () => {
    const genericError = new Error('upstream protocol error');
    expect(consumeSessionStormBackoffMs('session:generic', genericError)).toBe(1000);

    const clientToolArgsError = Object.assign(
      new Error('converted provider tool call has invalid client arguments'),
      { code: 'CLIENT_TOOL_ARGS_INVALID' }
    );
    expect(consumeSessionStormBackoffMs('session:hard-block', clientToolArgsError)).toBe(1000);
  });
});
