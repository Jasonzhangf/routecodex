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
