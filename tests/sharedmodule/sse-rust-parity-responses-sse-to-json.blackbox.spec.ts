import { describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';

import { ResponsesSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.js';

async function decodeResponsesSse(sseText: string, options: Record<string, unknown> = {}) {
  const converter = new ResponsesSseToJsonConverter();
  return converter.convertSseToJson(Readable.from([sseText]), {
    requestId: 'req_responses_sse_decode_parity',
    model: 'gpt-test',
    ...options
  });
}

function frames(parts: string[]): string {
  return `${parts.join('\n\n')}\n\n`;
}

describe('Responses SSE to JSON Rust parity boundary', () => {
  it('materializes provider output text SSE into final Responses JSON through native materializer', async () => {
    const response = await decodeResponsesSse(frames([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_decode_text","object":"response","created_at":1781149537,"status":"in_progress","model":"gpt-test","output":[]}}',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"hello"}',
      'event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"item_id":"msg_1","content_index":0,"text":"hello"}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_decode_text","object":"response","created_at":1781149537,"status":"completed","model":"gpt-test","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      'event: response.done\ndata: {"type":"response.done","response":{"id":"resp_decode_text","object":"response","created_at":1781149537,"status":"completed","model":"gpt-test","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}',
      'data: [DONE]'
    ]));

    expect(response).toMatchObject({
      id: 'resp_decode_text',
      object: 'response',
      status: 'completed',
      model: 'gpt-test',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello' }]
        }
      ]
    });
    expect(JSON.stringify(response)).not.toContain('__rt');
    expect(JSON.stringify(response)).not.toContain('metadata');
  });

  it('aggregates function_call argument deltas exactly', async () => {
    const response = await decodeResponsesSse(frames([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_decode_function","object":"response","created_at":1781149537,"status":"in_progress","model":"gpt-test","output":[]}}',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"exec_command","arguments":""}}',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","call_id":"call_1","delta":"{\\"cmd\\":"}',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","call_id":"call_1","delta":"\\"pwd\\"}"}',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","call_id":"call_1","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"exec_command","arguments":""}}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_decode_function","object":"response","created_at":1781149537,"status":"completed","model":"gpt-test","output":[]}}',
      'event: response.done\ndata: {"type":"response.done","response":{"id":"resp_decode_function","object":"response","created_at":1781149537,"status":"completed","model":"gpt-test","output":[]}}',
      'data: [DONE]'
    ]));

    expect(response.output[0]).toMatchObject({
      id: 'fc_1',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}'
    });
  });

  it('materializes reasoning summary and omits replay-unsafe metadata', async () => {
    const response = await decodeResponsesSse(frames([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_decode_reasoning","object":"response","created_at":1781149537,"status":"in_progress","model":"gpt-test","output":[],"metadata":{"secret":"must-not-leak"}}}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"summary"}],"content":[{"type":"reasoning_text","text":"private chain"}],"status":"completed"}}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_decode_reasoning","object":"response","created_at":1781149537,"status":"completed","model":"gpt-test","output":[{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"summary"}],"content":[{"type":"reasoning_text","text":"private chain"}],"status":"completed"}],"metadata":{"secret":"must-not-leak"}}}',
      'event: response.done\ndata: {"type":"response.done","response":{"id":"resp_decode_reasoning","object":"response","created_at":1781149537,"status":"completed","model":"gpt-test","output":[{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"summary"}],"content":[{"type":"reasoning_text","text":"private chain"}],"status":"completed"}],"metadata":{"secret":"must-not-leak"}}}',
      'data: [DONE]'
    ]));

    expect(response.output[0]).toMatchObject({
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'summary' }]
    });
    expect(JSON.stringify(response)).not.toContain('must-not-leak');
  });

  it('surfaces provider stream error event as decode failure instead of success salvage', async () => {
    await expect(decodeResponsesSse(frames([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_decode_error","object":"response","created_at":1781149537,"status":"in_progress","model":"gpt-test","output":[]}}',
      'event: response.error\ndata: {"type":"response.error","error":{"message":"provider failed","code":"upstream_error"}}'
    ]))).rejects.toMatchObject({
      code: 'SSE_TO_JSON_ERROR'
    });
  });

  it('does not silently complete when the provider stream closes before terminal response.done', async () => {
    async function* partialStream(): AsyncGenerator<string> {
      yield frames([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_decode_incomplete","object":"response","created_at":1781149537,"status":"in_progress","model":"gpt-test","output":[]}}',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"partial"}'
      ]);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const converter = new ResponsesSseToJsonConverter();

    await expect(converter.convertSseToJson(partialStream(), {
      requestId: 'req_responses_decode_incomplete',
      model: 'gpt-test'
    })).rejects.toMatchObject({
      code: 'SSE_TO_JSON_ERROR'
    });
  });
});
