import { describe, expect, it } from '@jest/globals';

import { ResponsesSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.js';

describe('responses SSE decode wire input boundary', () => {
  it('materializes wire text without requiring caller debug options', async () => {
    const converter = new ResponsesSseToJsonConverter();
    const sseText = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_options_optional","object":"response","created_at":1710000000,"status":"in_progress","model":"gpt-5.4-mini","output":[]}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_options_optional","object":"response","created_at":1710000000,"status":"completed","model":"gpt-5.4-mini","output":[]}}',
      '',
      'event: response.done',
      'data: {"type":"response.done","response":{"id":"resp_options_optional","object":"response","created_at":1710000000,"status":"completed","model":"gpt-5.4-mini","output":[]}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const response = await converter.convertSseToJson(sseText);

    expect(response.id).toBe('resp_options_optional');
    expect(response.status).toBe('completed');
  });

  it('rejects object-mode chunks instead of serializing them through TS', async () => {
    const converter = new ResponsesSseToJsonConverter();
    async function* objectChunks(): AsyncGenerator<unknown> {
      yield {
        type: 'response.done',
        data: { type: 'response.done', response: { id: 'resp_object_chunk' } }
      };
    }

    await expect(converter.convertSseToJson(objectChunks() as AsyncIterable<string | Buffer>, {
      requestId: 'req_responses_object_chunk_no_ts_serializer',
      model: 'gpt-test'
    })).rejects.toThrow('Responses SSE decode requires wire string, Buffer, or Uint8Array chunks');
  });
});
