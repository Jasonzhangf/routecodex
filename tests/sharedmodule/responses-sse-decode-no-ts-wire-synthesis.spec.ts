import { describe, expect, it } from '@jest/globals';

import { ResponsesSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.js';

describe('responses SSE decode wire input boundary', () => {
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
