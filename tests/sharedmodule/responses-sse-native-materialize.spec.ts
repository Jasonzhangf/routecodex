import { describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';

import { ResponsesSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.js';

describe('responses SSE native materialize', () => {
  it('materializes custom_tool_call output items via native response envelope parser', async () => {
    const sseText = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_custom_tool_1","object":"response","created_at":1710000000,"status":"in_progress","model":"gpt-5.4-mini","output":[]}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"ctc_1","type":"custom_tool_call","call_id":"call_custom_1","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_custom_tool_1","object":"response","created_at":1710000000,"status":"completed","model":"gpt-5.4-mini","output":[{"id":"ctc_1","type":"custom_tool_call","call_id":"call_custom_1","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
      'event: response.done',
      'data: {"type":"response.done","response":{"id":"resp_custom_tool_1","object":"response","created_at":1710000000,"status":"completed","model":"gpt-5.4-mini","output":[{"id":"ctc_1","type":"custom_tool_call","call_id":"call_custom_1","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch"}]}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ResponsesSseToJsonConverter();
    const response = await converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_custom_tool_call_native_materialize',
      model: 'gpt-5.4-mini'
    });

    expect(response.id).toBe('resp_custom_tool_1');
    expect(response.status).toBe('completed');
    expect(Array.isArray(response.output)).toBe(true);
    expect((response.output as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'call_custom_1',
      name: 'apply_patch'
    });
  });
});
