import { Readable } from 'node:stream';
import { describe, expect, it } from '@jest/globals';

import { ResponsesSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.js';

describe('responses SSE custom_tool_call materialize', () => {
  it('materializes custom_tool_call SSE via native parser without TS output-item rejection', async () => {
    const converter = new ResponsesSseToJsonConverter();
    const patch = '*** Begin Patch\n*** Add File: tmp/native-materialize-smoke.txt\n+hello\n*** End Patch';
    const stream = Readable.from([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_custom_tool_1","object":"response","status":"in_progress","model":"gpt-5.5","output":[]}}\n\n',
      'event: response.output_item.added\n',
      `data: ${JSON.stringify({
        type: 'response.output_item.added',
        item: {
          id: 'fc_patch_1',
          type: 'custom_tool_call',
          call_id: 'call_patch_1',
          name: 'apply_patch',
          input: patch,
          status: 'in_progress'
        }
      })}\n\n`,
      'event: response.output_item.done\n',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'fc_patch_1',
          type: 'custom_tool_call',
          call_id: 'call_patch_1',
          name: 'apply_patch',
          input: patch,
          status: 'completed'
        }
      })}\n\n`,
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_custom_tool_1","object":"response","status":"completed","model":"gpt-5.5","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      'data: [DONE]\n\n'
    ]);

    const response = await converter.convertSseToJson(stream, {
      requestId: 'req_custom_tool_call_native_materialize',
      model: 'gpt-5.5'
    });

    expect(response.status).toBe('completed');
    expect((response.output[0] as any).type).toBe('custom_tool_call');
    expect((response.output[0] as any).name).toBe('apply_patch');
    expect((response.output[0] as any).call_id).toBe('call_patch_1');
    expect((response.output[0] as any).input).toBe(patch);
  });
});
