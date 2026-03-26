import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_SSE_PARSER_CONFIG,
  parseSseEvent,
  parseSseStream,
  parseSseStreamAsync
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

  it('recovers invalid json as error event when recovery enabled', () => {
    const result = parseSseEvent('event: response.output_text.delta\ndata: {invalid-json}');
    expect(result.success).toBe(true);
    expect(result.event?.type).toBe('error');
    expect((result.event?.data as { error?: string })?.error).toBe('Invalid JSON');
  });

  it('parses stream in native path and filters invalid strict events', () => {
    const stream = [
      'event: response.completed',
      'data: {"type":"response.completed"}',
      '',
      'event: custom.type',
      'data: {"ok":true}',
      ''
    ].join('\n');

    const output = Array.from(parseSseStream(stream, {
      ...DEFAULT_SSE_PARSER_CONFIG,
      enableStrictValidation: true,
      enableEventRecovery: false
    }));

    expect(output).toHaveLength(1);
    expect(output[0]?.success).toBe(true);
    expect(output[0]?.event?.type).toBe('response.completed');
  });

  it('parses async chunk stream in native path with chunk boundaries', async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
      yield 'event: response.completed\ndata: {"type":"response.completed"';
      yield '}\n\n';
    }

    const output: ReturnType<typeof parseSseEvent>[] = [];
    for await (const item of parseSseStreamAsync(chunks(), {
      ...DEFAULT_SSE_PARSER_CONFIG,
      enableStrictValidation: true,
      enableEventRecovery: false
    })) {
      output.push(item);
    }

    expect(output).toHaveLength(2);
    expect(output[0]?.event?.type).toBe('response.completed');
    expect(output[1]?.event?.type).toBe('response.completed');
  });

  it('parses async stream with CRLF separators in native path', async () => {
    async function* crlfChunks(): AsyncGenerator<string> {
      yield 'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n';
      yield 'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n';
    }

    const output: ReturnType<typeof parseSseEvent>[] = [];
    for await (const item of parseSseStreamAsync(crlfChunks(), {
      ...DEFAULT_SSE_PARSER_CONFIG,
      enableStrictValidation: true,
      enableEventRecovery: false
    })) {
      output.push(item);
    }

    expect(output).toHaveLength(2);
    expect(output[0]?.event?.protocol).toBe('responses');
    expect(output[1]?.event?.protocol).toBe('responses');
  });
});
