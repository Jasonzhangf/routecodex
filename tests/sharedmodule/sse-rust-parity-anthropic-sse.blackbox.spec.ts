import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  buildAnthropicJsonFromSseWithNative,
  buildAnthropicSseEventSequenceWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-anthropic-sse-event-payload.js';
import { AnthropicSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.js';
import type { AnthropicMessageResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function toSseBody(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function* streamChunks(chunks: Array<string | Buffer>): AsyncGenerator<string | Buffer> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('Anthropic JSON to SSE Rust parity boundary', () => {
  it('matches native sequence for text and tool_use blocks', async () => {
    const response: AnthropicMessageResponse = {
      id: 'msg_anthropic_sequence_text_tool',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { city: 'SF' } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 }
    };
    const config = { chunkSize: 5, reasoningMode: 'channel' as const };

    const tsEvents = await collectEvents(buildAnthropicSseEventSequenceWithNative({ response, config }));
    const nativeEvents = buildAnthropicSseEventSequenceWithNative({ response, config });

    expect(tsEvents).toEqual(nativeEvents);
    expect(tsEvents.map((event: any) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ]);
    expect((tsEvents[2] as any).data.delta.text).toBe('hello');
    expect((tsEvents[7] as any).data.delta.partial_json).toBe('{"city":"SF"}');
  });

  it('keeps Anthropic reasoning projection native-owned', async () => {
    const response: AnthropicMessageResponse = {
      id: 'msg_anthropic_reasoning',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'thinking', text: 'hidden plan', signature: 'sig_ignored_by_legacy_ts' }],
      stop_reason: 'end_turn'
    };
    const config = {
      chunkSize: 1024,
      reasoningMode: 'text' as const,
      reasoningTextPrefix: '[thought] '
    };

    const tsEvents = await collectEvents(buildAnthropicSseEventSequenceWithNative({ response, config }));
    const nativeEvents = buildAnthropicSseEventSequenceWithNative({ response, config });

    expect(tsEvents).toEqual(nativeEvents);
    expect((tsEvents[1] as any).data.content_block.type).toBe('text');
    expect((tsEvents[2] as any).data.delta).toEqual({
      type: 'text_delta',
      text: '[thought] hidden plan'
    });
    expect(JSON.stringify(tsEvents)).not.toContain('sig_ignored_by_legacy_ts');
  });

  it('fails fast through native when stop_reason is missing', async () => {
    const response = {
      id: 'msg_anthropic_missing_stop_reason',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'hello' }]
    };
    

    expect(() => buildAnthropicSseEventSequenceWithNative({ response })).toThrow('Invalid Anthropic response: missing stop_reason');
    expect(() => buildAnthropicSseEventSequenceWithNative({ response })).toThrow(
      'Invalid Anthropic response: missing stop_reason'
    );
  });

  it('fails fast through native when tool_result.tool_use_id is missing', async () => {
    const response = {
      id: 'msg_anthropic_missing_tool_use_id',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'tool_result', content: 'done' }],
      stop_reason: 'end_turn'
    };
    

    expect(() => buildAnthropicSseEventSequenceWithNative({ response })).toThrow('Invalid Anthropic tool_result block: missing tool_use_id');
    expect(() => buildAnthropicSseEventSequenceWithNative({ response })).toThrow(
      'Invalid Anthropic tool_result block: missing tool_use_id'
    );
  });

  it('keeps the native Anthropic SSE sequence wrapper as the only owner', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-anthropic-sse-event-payload.ts'),
      'utf8'
    );
    expect(source).toContain('buildAnthropicSseEventSequenceWithNative');
    expect(source).toContain('buildAnthropicSseStreamFramesWithNative');
  });

  it('decodes Anthropic SSE through the native Rust decoder', async () => {
    const response: AnthropicMessageResponse = {
      id: 'msg_anthropic_decode_native',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'text', text: 'hello decode' },
        { type: 'tool_use', id: 'tool_decode', name: 'lookup', input: { query: 'weather' } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 }
    };
    const events = buildAnthropicSseEventSequenceWithNative({ response, config: { chunkSize: 5 } });
    const bodyText = toSseBody(events);
    const converter = new AnthropicSseToJsonConverter();

    const decoded = await converter.convertSseToJson(streamChunks([bodyText.slice(0, 80), Buffer.from(bodyText.slice(80))]), {
      requestId: 'req_anthropic_decode_native',
      model: 'claude-test'
    });
    const nativeDecoded = buildAnthropicJsonFromSseWithNative({ bodyText });

    expect(decoded).toEqual(nativeDecoded);
    expect(decoded).toEqual(response);
  });

  it('keeps the TS Anthropic SSE decoder as a native-backed thin shell', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.ts'),
      'utf8'
    );
    const builderSourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/anthropic-response-builder.ts'
    );

    expect(source).toContain('buildAnthropicJsonFromSseWithNative');
    expect(source).not.toContain('createAnthropicResponseBuilder');
    expect(source).not.toContain('createSseParser');
    expect(fs.existsSync(builderSourcePath)).toBe(false);
  });
});
