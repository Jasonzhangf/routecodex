import { describe, it, expect } from '@jest/globals';
import { AnthropicSseToJsonConverter } from '../sse-to-json/anthropic-sse-to-json-converter.js';
import { DEFAULT_CONVERSION_CONFIG } from '../types/conversion-context.js';
import { DEFAULT_CHAT_CONVERSION_CONFIG } from '../types/chat-types.js';
import { DEFAULT_RESPONSES_CONVERSION_CONFIG } from '../types/responses-types.js';

async function convertAnthropicSse(payload: string) {
  const converter = new AnthropicSseToJsonConverter();
  const stream = (async function* () {
    yield payload;
  })();
  return converter.convertSseToJson(stream, {
    requestId: 'req_anthropic_hidden_reasoning'
  });
}

describe('Anthropic SSE hidden reasoning mapping', () => {
  it('keeps thinking deltas that use the `thinking` field and preserves signature/redacted blocks', async () => {
    const ssePayload = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"glm-5"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"internal reasoning text"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_payload"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"enc_payload"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

event: message_stop
data: {"type":"message_stop"}
`;

    const response = await convertAnthropicSse(ssePayload);
    const content = Array.isArray(response.content) ? response.content : [];
    expect(content.some((item: any) => item?.type === 'thinking' && item?.text === 'internal reasoning text')).toBe(true);
    expect(content.some((item: any) => item?.type === 'redacted_thinking' && item?.data === 'sig_payload')).toBe(true);
    expect(content.some((item: any) => item?.type === 'redacted_thinking' && item?.data === 'enc_payload')).toBe(true);
  });

  it('treats incomplete anthropic SSE as retryable error instead of fake success', async () => {
    const ssePayload = `event: message_start
data: {"type":"message_start","message":{"id":"msg_incomplete","type":"message","role":"assistant","model":"glm-5"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial text"}}
`;

    await expect(convertAnthropicSse(ssePayload)).rejects.toMatchObject({
      code: 'ANTHROPIC_SSE_TO_JSON_FAILED',
      status: 502,
      statusCode: 502,
      retryable: true,
      upstreamCode: 'UPSTREAM_STREAM_INCOMPLETE',
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('uses 15-minute SSE conversion defaults', () => {
    expect(DEFAULT_CONVERSION_CONFIG.defaultTimeoutMs).toBe(900000);
    expect(DEFAULT_CONVERSION_CONFIG.inactivityTimeoutMs).toBe(900000);
    expect(DEFAULT_CHAT_CONVERSION_CONFIG.defaultTimeoutMs).toBe(900000);
    expect(DEFAULT_RESPONSES_CONVERSION_CONFIG.defaultTimeoutMs).toBe(900000);
  });
});
