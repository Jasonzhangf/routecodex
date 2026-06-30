import { describe, expect, it } from '@jest/globals';

import { ResponsesEventSerializer } from '../../sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.js';

describe('responses event serializer no-salvage boundary', () => {
  it('throws on invalid JSON data instead of returning the raw payload string', () => {
    const serializer = new ResponsesEventSerializer();

    expect(() => serializer.deserializeFromWire(
      'event: response.done\n' +
      'id: 123\n' +
      'data: not-json\n'
    )).toThrow('Invalid Responses SSE data payload: not-json');
  });

  it('throws when the timestamp is missing instead of using the current time', () => {
    const serializer = new ResponsesEventSerializer();

    expect(() => serializer.deserializeFromWire(
      'event: response.done\n' +
      'data: {"type":"response.done","response":{}}\n'
    )).toThrow('Missing Responses SSE timestamp');
  });

  it('throws when the timestamp is invalid instead of parsing a fallback time', () => {
    const serializer = new ResponsesEventSerializer();

    expect(() => serializer.deserializeFromWire(
      'event: response.done\n' +
      'id: not-a-timestamp\n' +
      'data: {"type":"response.done","response":{}}\n'
    )).toThrow('Invalid Responses SSE timestamp: not-a-timestamp');
  });

  it('throws on non-string wire validation input instead of returning false', () => {
    const serializer = new ResponsesEventSerializer();

    expect(() => serializer.validateWireFormat(null as unknown as string)).toThrow();
  });

  it('does not expose static event factory helpers that synthesize timestamps', () => {
    expect((ResponsesEventSerializer as unknown as Record<string, unknown>).createResponseCreatedEvent).toBeUndefined();
    expect((ResponsesEventSerializer as unknown as Record<string, unknown>).createResponseInProgressEvent).toBeUndefined();
    expect((ResponsesEventSerializer as unknown as Record<string, unknown>).createResponseCompletedEvent).toBeUndefined();
    expect((ResponsesEventSerializer as unknown as Record<string, unknown>).createRequiredActionEvent).toBeUndefined();
    expect((ResponsesEventSerializer as unknown as Record<string, unknown>).createResponseDoneEvent).toBeUndefined();
    expect((ResponsesEventSerializer as unknown as Record<string, unknown>).createResponseErrorEvent).toBeUndefined();
  });
});
