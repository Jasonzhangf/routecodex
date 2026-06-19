import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  consumeSessionStormBackoffMs,
  isSessionStormBackoffCandidate,
  peekSessionStormBackoffWaitMs,
  resolveSessionStormBackoffScopes,
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

  test('does not treat generic surfaced application errors as session storm candidates', () => {
    const error = new Error(
      'router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat'
    );

    expect(isSessionStormBackoffCandidate(error)).toBe(false);
    expect(peekSessionStormBackoffWaitMs('session:any-error')).toBe(0);
  });

  test('routes only session-local hard-block candidates through the unified queue', () => {
    const clientToolArgsError = Object.assign(
      new Error('converted provider tool call has invalid client arguments'),
      { code: 'CLIENT_TOOL_ARGS_INVALID' }
    );
    expect(isSessionStormBackoffCandidate(clientToolArgsError)).toBe(true);
    expect(consumeSessionStormBackoffMs('session:hard-block', clientToolArgsError)).toBe(1000);
  });

  test('does not treat provider availability errors as session storm candidates', () => {
    const provider429 = Object.assign(new Error('HTTP 429: upstream rate limited'), {
      statusCode: 429,
      code: 'HTTP_429',
      upstreamCode: 'HTTP_429'
    });
    const providerUnavailable = Object.assign(
      new Error('No available providers after applying routing instructions'),
      { code: 'PROVIDER_NOT_AVAILABLE' }
    );
    const fetchFailed = new Error('fetch failed');

    expect(isSessionStormBackoffCandidate(provider429)).toBe(false);
    expect(isSessionStormBackoffCandidate(providerUnavailable)).toBe(false);
    expect(isSessionStormBackoffCandidate(fetchFailed)).toBe(false);
  });

  test('does not derive session storm scope from flat request metadata without metadata center truth', () => {
    expect(resolveSessionStormBackoffScopes({
      sessionId: 'flat-session',
      conversationId: 'flat-conversation',
      clientType: 'codex'
    })).toEqual(['clientType:codex']);
  });

  test('derives session storm scope from metadata center request truth', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'truth-session',
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts',
        symbol: 'derives session storm scope from metadata center request truth',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'truth-conversation',
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts',
        symbol: 'derives session storm scope from metadata center request truth',
        stage: 'test'
      }
    );

    expect(resolveSessionStormBackoffScopes(metadata)).toEqual([
      'session:truth-session',
      'conversation:truth-conversation'
    ]);
  });
});
