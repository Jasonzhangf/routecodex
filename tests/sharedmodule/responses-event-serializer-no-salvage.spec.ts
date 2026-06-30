import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  deserializeResponsesSseEventFromWireWithNative,
  serializeResponsesSseEventToWireWithNative,
  validateResponsesSseWireFormatWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';

describe('responses event serializer no-salvage boundary', () => {
  it('keeps the retired TS serializer file physically deleted', () => {
    expect(fs.existsSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.ts'
    ))).toBe(false);
  });

  it('throws on invalid JSON data instead of returning the raw payload string', () => {
    expect(() => deserializeResponsesSseEventFromWireWithNative(
      'event: response.done\n' +
      'id: 123\n' +
      'data: not-json\n'
    )).toThrow('Invalid Responses SSE data payload: not-json');
  });

  it('throws when the timestamp is missing instead of using the current time', () => {
    expect(() => deserializeResponsesSseEventFromWireWithNative(
      'event: response.done\n' +
      'data: {"type":"response.done","response":{}}\n'
    )).toThrow('Missing Responses SSE timestamp');
  });

  it('throws when the timestamp is invalid instead of parsing a fallback time', () => {
    expect(() => deserializeResponsesSseEventFromWireWithNative(
      'event: response.done\n' +
      'id: not-a-timestamp\n' +
      'data: {"type":"response.done","response":{}}\n'
    )).toThrow('Invalid Responses SSE timestamp: not-a-timestamp');
  });

  it('throws on non-string wire validation input instead of returning false', () => {
    expect(() => validateResponsesSseWireFormatWithNative(null as unknown as string)).toThrow();
  });

  it('serializes canonical response SSE payloads through the native owner', () => {
    expect(serializeResponsesSseEventToWireWithNative({
      type: 'response.completed',
      timestamp: 123,
      protocol: 'responses',
      direction: 'json_to_sse',
      data: { type: 'response.completed', response: { id: 'resp_1' } }
    })).toBe('event: response.completed\ndata: {"response":{"id":"resp_1"},"type":"response.completed"}\nid: 123\n\n');
  });

  it('throws when serializing a payload that is missing its canonical event type', () => {
    expect(() => serializeResponsesSseEventToWireWithNative({
      type: 'response.completed',
      timestamp: 123,
      protocol: 'responses',
      direction: 'json_to_sse',
      data: { response: { id: 'resp_1' } }
    })).toThrow('Responses SSE payload missing canonical type for response.completed');
  });

  it('throws when serializing scalar event data instead of wrapping it as semantic value', () => {
    expect(() => serializeResponsesSseEventToWireWithNative({
      type: 'response.output_text.delta',
      timestamp: 123,
      protocol: 'responses',
      direction: 'json_to_sse',
      data: 'hello'
    })).toThrow('Responses event payload must be an object before serialization: response.output_text.delta');
  });

  it('throws on unknown response-prefixed event types instead of wildcard serializing them', () => {
    expect(() => serializeResponsesSseEventToWireWithNative({
      type: 'response.future_event' as any,
      timestamp: 123,
      protocol: 'responses',
      direction: 'json_to_sse',
      data: { type: 'response.future_event' }
    })).toThrow('Unsupported ResponsesSseEvent type: response.future_event');
  });
});
