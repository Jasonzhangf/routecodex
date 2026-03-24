import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_SSE_PARSER_CONFIG,
  parseSseEvent
} from '../../src/sse/sse-to-json/parsers/sse-parser.js';

describe('sse parser native infer event type', () => {
  it('infers responses event type from message data payload', () => {
    const result = parseSseEvent('data: {"type":"response.output_text.delta","delta":"hi"}');
    expect(result.success).toBe(true);
    expect(result.event?.type).toBe('response.output_text.delta');
  });

  it('keeps unknown type as invalid message event', () => {
    const result = parseSseEvent('data: {"type":"unknown.type","delta":"hi"}');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid event type: message');
  });

  it('maps anthropic event to anthropic protocol via native detector', () => {
    const result = parseSseEvent('event: message_stop\ndata: {"type":"message_stop"}');
    expect(result.success).toBe(true);
    expect(result.event?.protocol).toBe('anthropic-messages');
  });

  it('maps gemini event to gemini protocol via native detector', () => {
    const result = parseSseEvent('event: gemini.done\ndata: {"type":"gemini.done"}');
    expect(result.success).toBe(true);
    expect(result.event?.protocol).toBe('gemini-chat');
  });

  it('allows custom event type when strict validation disabled via native validator', () => {
    const result = parseSseEvent(
      'event: custom.type\ndata: {"ok":true}',
      { ...DEFAULT_SSE_PARSER_CONFIG, enableStrictValidation: false }
    );
    expect(result.success).toBe(true);
    expect(result.event?.type).toBe('custom.type');
  });

  it('rejects custom event type when strict validation enabled via native validator', () => {
    const result = parseSseEvent(
      'event: custom.type\ndata: {"ok":true}',
      { ...DEFAULT_SSE_PARSER_CONFIG, enableStrictValidation: true }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid event type: custom.type');
  });

  it('infers custom data.type when strict validation disabled', () => {
    const result = parseSseEvent(
      'data: {"type":"custom.type","delta":"hi"}',
      { ...DEFAULT_SSE_PARSER_CONFIG, enableStrictValidation: false }
    );
    expect(result.success).toBe(true);
    expect(result.event?.type).toBe('custom.type');
  });

  it('accepts CRLF payload while keeping parse semantics in native path', () => {
    const result = parseSseEvent('event: response.completed\r\ndata: {"type":"response.completed"}\r\n');
    expect(result.success).toBe(true);
    expect(result.event?.type).toBe('response.completed');
  });
});
