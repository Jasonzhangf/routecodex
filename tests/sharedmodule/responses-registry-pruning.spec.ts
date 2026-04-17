import { jest } from '@jest/globals';
import {
  consumeResponsesOutputTextMeta,
  consumeResponsesPayloadSnapshotByAliases,
  consumeResponsesPassthrough,
  consumeResponsesPassthroughByAliases,
  consumeResponsesPayloadSnapshot,
  registerResponsesOutputTextMeta,
  registerResponsesPassthrough,
  registerResponsesPayloadSnapshot
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.js';

describe('responses registry pruning', () => {
  const originalTtlEnv = process.env.ROUTECODEX_RESPONSES_METADATA_TTL_MS;
  const originalMaxEnv = process.env.ROUTECODEX_RESPONSES_METADATA_MAX_ENTRIES;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-15T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalTtlEnv === undefined) {
      delete process.env.ROUTECODEX_RESPONSES_METADATA_TTL_MS;
    } else {
      process.env.ROUTECODEX_RESPONSES_METADATA_TTL_MS = originalTtlEnv;
    }
    if (originalMaxEnv === undefined) {
      delete process.env.ROUTECODEX_RESPONSES_METADATA_MAX_ENTRIES;
    } else {
      process.env.ROUTECODEX_RESPONSES_METADATA_MAX_ENTRIES = originalMaxEnv;
    }
  });

  it('prunes stale retained payload snapshots before registering new metadata', () => {
    process.env.ROUTECODEX_RESPONSES_METADATA_TTL_MS = '1000';
    process.env.ROUTECODEX_RESPONSES_METADATA_MAX_ENTRIES = '10';

    registerResponsesPayloadSnapshot('resp-stale', {
      id: 'resp-stale',
      object: 'response',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old' }] }]
    });

    jest.advanceTimersByTime(1500);
    registerResponsesOutputTextMeta('resp-fresh', {
      hasField: true,
      value: 'fresh'
    });

    expect(consumeResponsesPayloadSnapshot('resp-stale')).toBeUndefined();
    expect(consumeResponsesOutputTextMeta('resp-fresh')).toEqual({
      hasField: true,
      value: 'fresh',
      raw: undefined
    });
  });

  it('caps retained metadata entries by oldest touch time', () => {
    process.env.ROUTECODEX_RESPONSES_METADATA_TTL_MS = '600000';
    process.env.ROUTECODEX_RESPONSES_METADATA_MAX_ENTRIES = '2';

    registerResponsesPayloadSnapshot('resp-1', {
      id: 'resp-1',
      object: 'response'
    });
    jest.advanceTimersByTime(10);
    registerResponsesOutputTextMeta('resp-2', {
      hasField: true,
      value: 'two'
    });
    jest.advanceTimersByTime(10);
    registerResponsesPayloadSnapshot('resp-3', {
      id: 'resp-3',
      object: 'response'
    });

    expect(consumeResponsesPayloadSnapshot('resp-1')).toBeUndefined();
    expect(consumeResponsesOutputTextMeta('resp-2')).toEqual({
      hasField: true,
      value: 'two',
      raw: undefined
    });
    expect(consumeResponsesPayloadSnapshot('resp-3')).toMatchObject({
      id: 'resp-3',
      object: 'response'
    });
  });

  it('consumes and clears all alias keys for retained payload snapshots and passthrough payloads', () => {
    const snapshot = {
      id: 'resp-alias',
      request_id: 'req-alias',
      object: 'response'
    };
    const passthrough = {
      id: 'resp-alias',
      request_id: 'req-alias',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    };

    registerResponsesPayloadSnapshot('resp-alias', snapshot, { clone: false });
    registerResponsesPayloadSnapshot('req-alias', snapshot, { clone: false });
    registerResponsesPassthrough('resp-alias', passthrough, { clone: false });
    registerResponsesPassthrough('req-alias', passthrough, { clone: false });

    expect(consumeResponsesPayloadSnapshotByAliases(['req-alias', 'resp-alias'])).toMatchObject({
      id: 'resp-alias',
      request_id: 'req-alias'
    });
    expect(consumeResponsesPassthroughByAliases(['req-alias', 'resp-alias'])).toMatchObject({
      id: 'resp-alias',
      request_id: 'req-alias'
    });

    expect(consumeResponsesPayloadSnapshot('req-alias')).toBeUndefined();
    expect(consumeResponsesPayloadSnapshot('resp-alias')).toBeUndefined();
    expect(consumeResponsesPassthrough('req-alias')).toBeUndefined();
    expect(consumeResponsesPassthrough('resp-alias')).toBeUndefined();
  });
});
