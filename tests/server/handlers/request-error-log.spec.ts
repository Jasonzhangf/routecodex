import { jest } from '@jest/globals';
import { logRequestError } from '../../../src/server/handlers/handler-utils.js';

describe('logRequestError diagnostics', () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    errorSpy.mockClear();
  });

  afterAll(() => {
    errorSpy.mockRestore();
  });

  it('prints structured status/code/upstreamCode when present on error object', () => {
    const err: any = new Error('provider failed');
    err.statusCode = 429;
    err.code = 'SSE_TO_JSON_ERROR';
    err.upstreamCode = 'EPIPE';

    logRequestError('/v1/responses', 'req_structured_fields', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('status=429'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('code=SSE_TO_JSON_ERROR'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('upstreamCode=EPIPE'));
  });

  it('parses status/code/upstreamCode from raw error snippet text', () => {
    const err: any = new Error('upstream failed');
    err.rawErrorSnippet =
      'HTTP 429: {"error":{"code":"SSE_TO_JSON_ERROR","message":"decoder crashed","upstream_code":"EPIPE"}}';

    logRequestError('/v1/responses', 'req_text_fields', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('status=429'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('code=SSE_TO_JSON_ERROR'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('upstreamCode=EPIPE'));
  });
});

