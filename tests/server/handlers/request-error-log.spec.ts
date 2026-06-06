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

  it('does not print upstream 429 provider payload in primary failure line', () => {
    const err: any = new Error(
      'HTTP 429: {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded, weekly usage limit reached for Token Plan Max (297510000/297510000 used), resets at 2026-06-08T00:00:00+08:00 (2056)"},"request_id":"067332f1228901ab7a06e6c2b2e23f5d"}'
    );
    err.statusCode = 429;
    err.code = 'HTTP_429';
    err.details = {
      upstreamCode: 'HTTP_429',
      upstreamMessage:
        '{"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded, weekly usage limit reached for Token Plan Max (297510000/297510000 used), resets at 2026-06-08T00:00:00+08:00 (2056)"},"request_id":"067332f1228901ab7a06e6c2b2e23f5d"}'
    };

    logRequestError('/v1/responses', 'req_429_public_summary', err);

    const firstLine = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(firstLine).toContain('Rate limited by upstream provider');
    expect(firstLine).toContain('status=429');
    expect(firstLine).toContain('code=HTTP_429');
    expect(firstLine).not.toContain('usage limit exceeded');
    expect(firstLine).not.toContain('Token Plan Max');
    expect(firstLine).not.toContain('067332f1228901ab7a06e6c2b2e23f5d');
  });
});
