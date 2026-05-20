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

  it('does not let code-only rawErrorSnippet override richer error message', () => {
    const err: any = new Error('HTTP 502: {"error":{"message":"Upstream request failed","type":"upstream_error"}}');
    err.code = 'HTTP_502';
    err.rawErrorSnippet = '{"error":{"code":"HTTP_502"}}';

    logRequestError('/v1/responses', 'req_code_only_shell', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Upstream request failed'));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('failed: {"error":{"code":"HTTP_502"}}'));
  });

  it('does not let code-only response.data shell override richer error message', () => {
    const err: any = new Error('HTTP 502: {"error":{"message":"Upstream request failed","type":"upstream_error"}}');
    err.code = 'HTTP_502';
    err.response = {
      data: {
        error: {
          code: 'HTTP_502'
        }
      }
    };

    logRequestError('/v1/responses', 'req_response_data_shell', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Upstream request failed'));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('failed: {"error":{"code":"HTTP_502"}}'));
  });
});
