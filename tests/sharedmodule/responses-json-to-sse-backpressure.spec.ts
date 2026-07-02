import { describe, expect, it } from '@jest/globals';

import { ResponsesJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';
import type { ResponsesResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

/**
 * Parse SSE event type from wire-format string: "event: X\ndata: ...\n\n"
 */
function parseSseType(sseChunk: string): string | null {
  const match = sseChunk.match(/^event: (\S+)/m);
  return match ? match[1] : null;
}

function buildLongTextResponse(): ResponsesResponse {
  return {
    id: 'resp_backpressure_terminal',
    object: 'response',
    created_at: 1710000000,
    status: 'completed',
    model: 'gpt-test',
    output: [
      {
        id: 'msg_backpressure_terminal',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz'
          }
        ]
      }
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: {
        cached_tokens: 0,
        audio_tokens: 0,
        text_tokens: 1,
        image_tokens: 0
      },
      output_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        text_tokens: 1
      }
    }
  };
}

describe('Responses JSON to SSE backpressure', () => {
  it('emits terminal events for finite Responses JSON projection before the client starts reading', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const sseStream = await converter.convertResponseToJsonToSse(buildLongTextResponse(), {
      requestId: 'req_backpressure_terminal',
      model: 'gpt-test',
      chunkSize: 1
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Consume stream to verify terminal events
    const events: string[] = [];
    for await (const event of sseStream) {
      // Thin shell serializes immediately to SSE wire format strings
      events.push(typeof event === 'string' ? event : String(event));
    }

    // Assert terminal SSE events exist in the wire-format output
    expect(events.filter((e: string) => parseSseType(e) === 'response.completed').length).toBe(1);
    expect(events.filter((e: string) => parseSseType(e) === 'response.done').length).toBe(1);
  });
});
