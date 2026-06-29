import { describe, expect, it } from '@jest/globals';

import { AnthropicSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.js';

async function *completeAnthropicMessageThenTerminated(): AsyncGenerator<string> {
  yield [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_no_salvage","type":"message","role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"usage":{"output_tokens":1}}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n');
  throw Object.assign(new Error('terminated'), { code: 'TERMINATED' });
}

describe('anthropic SSE no-salvage boundary', () => {
  it('does not salvage a completed builder result into success after stream termination', async () => {
    const converter = new AnthropicSseToJsonConverter();

    await expect(converter.convertSseToJson(completeAnthropicMessageThenTerminated(), {
      requestId: 'req_anthropic_no_salvage_terminated',
      model: 'claude-sonnet-4-5'
    })).rejects.toMatchObject({
      code: 'ANTHROPIC_SSE_TO_JSON_FAILED',
      statusCode: 502,
      retryable: true,
      upstreamCode: 'UPSTREAM_STREAM_TERMINATED',
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });
});
