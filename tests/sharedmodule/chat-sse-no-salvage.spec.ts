import { describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';

import { ChatSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.js';

describe('chat SSE no-salvage boundary', () => {
  it('does not salvage mixed-line chat_chunk payloads into a successful response', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"chatcmpl_no_salvage","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
      'data: not-json',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_no_salvage_mixed_lines',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      message: expect.stringContaining('Failed to parse chat_chunk'),
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });
});
