import { describe, expect, it } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { ResponsesSseToJsonConverter } from '../sse-to-json/index.js';

describe('Responses SSE fail-fast handling', () => {
  it('rejects incomplete SSE instead of salvaging partial response', async () => {
    const ssePayload = `event: response.created
data: {"type":"response.created","response":{"id":"resp_incomplete","object":"response","created_at":1710000000,"status":"in_progress","model":"gpt-4o-mini","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","item_id":"msg_incomplete","output_index":0,"item":{"id":"msg_incomplete","type":"message","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","item_id":"msg_incomplete","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_incomplete","output_index":0,"content_index":0,"delta":"partial text"}
`;

    const converter = new ResponsesSseToJsonConverter();
    const stream = new PassThrough();
    stream.end(ssePayload);

    await expect(
      converter.convertSseToJson(stream, {
        requestId: 'resp-incomplete'
      })
    ).rejects.toMatchObject({
      code: 'SSE_TO_JSON_ERROR',
      status: 502,
      statusCode: 502,
      retryable: true,
      upstreamCode: 'UPSTREAM_STREAM_INCOMPLETE',
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('keeps completed response successful even when response.done is missing', async () => {
    const ssePayload = `event: response.created
data: {"type":"response.created","response":{"id":"resp_completed","object":"response","created_at":1710000000,"status":"in_progress","model":"gpt-4o-mini","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","item_id":"msg_completed","output_index":0,"item":{"id":"msg_completed","type":"message","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","item_id":"msg_completed","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_completed","output_index":0,"content_index":0,"delta":"done text"}

event: response.output_text.done
data: {"type":"response.output_text.done","item_id":"msg_completed","output_index":0,"content_index":0,"text":"done text"}

event: response.content_part.done
data: {"type":"response.content_part.done","item_id":"msg_completed","output_index":0,"content_index":0,"part":{"type":"output_text","text":"done text"}}

event: response.output_item.done
data: {"type":"response.output_item.done","item_id":"msg_completed","output_index":0,"item":{"id":"msg_completed","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done text"}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_completed","object":"response","created_at":1710000000,"status":"completed","model":"gpt-4o-mini","output":[]}}
`;

    const converter = new ResponsesSseToJsonConverter();
    const stream = new PassThrough();
    stream.end(ssePayload);

    const response = await converter.convertSseToJson(stream, {
      requestId: 'resp-completed-without-done'
    });

    expect(response.status).toBe('completed');
  });

  it('preserves response.failed context_length_exceeded instead of misclassifying it as stream incomplete', async () => {
    const ssePayload = `event: response.created
data: {"type":"response.created","response":{"id":"resp_failed","object":"response","created_at":1710000000,"status":"in_progress","model":"gpt-5.3-codex","output":[]}}

event: response.in_progress
data: {"type":"response.in_progress","response":{"id":"resp_failed","object":"response","created_at":1710000000,"status":"in_progress","model":"gpt-5.3-codex","output":[]}}

event: error
data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"}}

event: response.failed
data: {"type":"response.failed","response":{"id":"resp_failed","object":"response","created_at":1710000000,"status":"failed","model":"gpt-5.3-codex","output":[],"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}}
`;

    const converter = new ResponsesSseToJsonConverter();
    const stream = new PassThrough();
    stream.end(ssePayload);

    await expect(
      converter.convertSseToJson(stream, {
        requestId: 'resp-failed-context-length'
      })
    ).rejects.toMatchObject({
      code: 'SSE_TO_JSON_ERROR',
      status: 400,
      statusCode: 400,
      retryable: false,
      upstreamCode: 'context_length_exceeded',
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });
});
