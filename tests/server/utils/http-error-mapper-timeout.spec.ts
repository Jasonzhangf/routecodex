import {
  mapErrorToHttp,
  projectSseErrorEventPayload,
} from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper timeout handling', () => {
  it('maps upstream timeout-style errors to 504', () => {
    const payload = mapErrorToHttp({
      message: 'UPSTREAM_HEADERS_TIMEOUT',
      code: 'UPSTREAM_HEADERS_TIMEOUT',
      requestId: 'req_test',
      providerKey: 'tab.default.gpt-5.1'
    });
    expect(payload.status).toBe(504);
    expect(payload.body.error.code).toBe('UPSTREAM_HEADERS_TIMEOUT');
  });

  it('projects SSE error event payloads from ErrorErr06 owner', () => {
    const payload = projectSseErrorEventPayload({
      requestId: 'req_test',
      status: 504,
      message: 'SSE timeout after 50ms',
      code: 'HTTP_SSE_TIMEOUT',
    });

    expect(payload).toEqual({
      type: 'error',
      status: 504,
      error: {
        message: 'SSE timeout after 50ms',
        code: 'HTTP_SSE_TIMEOUT',
        request_id: 'req_test',
      },
    });
  });

  it('preserves explicit upstream request ids in SSE error event payloads', () => {
    const payload = projectSseErrorEventPayload({
      requestId: 'req_local',
      status: 500,
      message: 'stream failed',
      code: 'sse_stream_error',
      error: {
        request_id: 'req_upstream',
      },
    });

    expect(payload.error.request_id).toBe('req_upstream');
    expect(payload.error.code).toBe('sse_stream_error');
  });
});
