import { describe, it, expect } from '@jest/globals';
import { AnthropicSseToJsonConverter } from '../sse-to-json/anthropic-sse-to-json-converter.js';

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
});

