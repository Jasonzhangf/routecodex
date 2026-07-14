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

  it('prints the final selected provider and wire model without changing the upstream error', () => {
    const err: any = new Error('API Key 所属分组已删除');
    err.statusCode = 403;
    err.code = 'HTTP_403';
    err.providerKey = 'cc-sol[key1]';
    err.providerModel = 'gpt-5.6-sol';

    logRequestError('/v1/responses', 'req_provider_model_observation', err);

    const rendered = String(errorSpy.mock.calls[0]?.[0] ?? '').replace(/\u001b\[[0-9;]*m/g, '');
    expect(err.message).toBe('API Key 所属分组已删除');
    expect(rendered).toContain('failed: Upstream provider error');
    expect(rendered).toContain('status=403');
    expect(rendered).toContain('code=HTTP_403');
    expect(rendered).toContain('provider=cc-sol[key1]');
    expect(rendered).toContain('model=gpt-5.6-sol');
  });

  it('does not print empty provider/model observation fields', () => {
    const err: any = new Error('provider failed before target selection');
    err.providerKey = '   ';
    err.providerModel = '';

    logRequestError('/v1/responses', 'req_without_provider_model_observation', err);

    const rendered = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).not.toContain('provider=');
    expect(rendered).not.toContain('model=');
  });

  it('prints internalCode when present on the error object', () => {
    const err: any = new Error('internal debug error');
    err.internalCode = '500-300';

    logRequestError('/v1/responses', 'req_internal_code', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('internalCode=500-300'));
  });

  it('prints internalCode when nested under internalError', () => {
    const err: any = new Error('internal debug error');
    err.internalError = { internalCode: '500-210' };

    logRequestError('/v1/responses', 'req_internal_error_object', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('internalCode=500-210'));
  });

  it('prints only the error code for responses store missing request context', () => {
    const err: any = new Error('Responses conversation request context missing for response capture');
    err.code = 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT';
    err.providerType = 'responses';
    err.details = {
      reason: 'missing_request_context',
      requestId: 'openai-responses-minimax.key1-MiniMax-M3-20260703T190155633-455538-1935',
      responseId: '0696c9a8793e5aa01f5e162d645c046b'
    };

    logRequestError('/v1/responses', 'req_store_missing_context', err);

    const rendered = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('failed: RESPONSES_STORE_MISSING_REQUEST_CONTEXT');
    expect(rendered).not.toContain('Responses conversation request context missing');
    expect(rendered).not.toContain('providerType=responses');
    expect(rendered).not.toContain('missing_request_context');
    expect(rendered).not.toContain('0696c9a8793e5aa01f5e162d645c046b');
  });

  it('does not collapse unstructured local runtime errors to generic upstream wording', () => {
    const err = new Error(
      'Rust HubPipeline request path failed: DIRECT_PAYLOAD_CONTRACT_ERROR: openai-responses provider wire input[3] function_call_output must not include content; use output only'
    );

    logRequestError('/v1/responses', 'req_unstructured_local_runtime_error', err);

    const firstLine = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(firstLine).toContain('Rust HubPipeline request path failed');
    expect(firstLine).toContain('function_call_output must not include content');
    expect(firstLine).not.toContain('failed: Upstream provider error');
  });

  it('marks generic upstream errors without structured cause as unclassified', () => {
    const err = new Error('Upstream provider error');

    logRequestError('/v1/responses', 'req_generic_upstream_no_fields', err);

    const firstLine = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(firstLine).toContain('Unclassified error: Upstream provider error');
    expect(firstLine).toContain('missing status/code');
  });

  it('prints provider route and stage fields when present on the error object', () => {
    const err: any = new Error('HTTP 502: upstream stream ended before final frame');
    err.statusCode = 502;
    err.code = 'UPSTREAM_STREAM_INCOMPLETE';
    err.upstreamCode = 'UPSTREAM_STREAM_INCOMPLETE';
    err.providerKey = 'cc.key1.gpt-5.5-anyint';
    err.routeName = 'longcontext';
    err.requestExecutorProviderErrorStage = 'provider.send';

    logRequestError('/v1/responses', 'req_provider_route_stage_fields', err);

    const firstLine = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(firstLine).toContain('provider=cc.key1.gpt-5.5-anyint');
    expect(firstLine).toContain('route=longcontext');
    expect(firstLine).toContain('stage=provider.send');
    expect(firstLine).toContain('code=UPSTREAM_STREAM_INCOMPLETE');
  });

  it('does not recurse through screenshot payload cycles while logging provider errors', () => {
    const imageUrl = `data:image/png;base64,${'A'.repeat(256 * 1024)}`;
    const err: any = new Error('HTTP 524: upstream timed out');
    err.statusCode = 524;
    err.code = 'HTTP_524';
    err.providerKey = 'asxs.crsa.gpt-5.4-mini';
    err.requestExecutorProviderErrorStage = 'provider.send';
    err.response = {
      data: {
        error: {
          code: 'HTTP_524',
          message: 'upstream timed out',
        },
        request: {
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'describe this screenshot' },
                { type: 'input_image', image_url: imageUrl },
              ],
            },
          ],
        },
      },
    };
    err.response.data.self = err.response.data;

    expect(() => logRequestError('/v1/responses', 'req_screenshot_cycle_error', err)).not.toThrow();

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('status=524');
    expect(rendered).toContain('code=HTTP_524');
    expect(rendered).toContain('provider=asxs.crsa.gpt-5.4-mini');
    expect(rendered).toContain('stage=provider.send');
    expect(rendered).not.toContain(imageUrl);
  });

  it('prints internalCode for RouteCodex-owned virtual-router retry route failures', () => {
    const err: any = new Error(
      'Rust HubPipeline explicit provider retry VR route failed: VIRTUAL_ROUTER_ERROR:PROVIDER_NOT_AVAILABLE:No available providers after applying routing instructions'
    );
    err.code = 'hub_pipeline_virtual_router_retry_route_failed';

    logRequestError('/v1/responses', 'req_vr_retry_route_failed', err);

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('code=hub_pipeline_virtual_router_retry_route_failed');
    expect(rendered).toContain('internalCode=500-130');
  });

  it('prints external transport source and reason for final ECONNRESET failures', () => {
    const err: any = new Error('{"error":{"code":"ECONNRESET","message":"fetch failed","status":502}}');
    err.statusCode = 502;
    err.code = 'ECONNRESET';
    err.upstreamCode = 'ECONNRESET';

    logRequestError('/v1/responses', 'req_final_econnreset', err);

    const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('status=502');
    expect(rendered).toContain('code=ECONNRESET');
    expect(rendered).toContain('upstreamCode=ECONNRESET');
    expect(rendered).toContain('source=external_transport');
    expect(rendered).toContain('reason="fetch failed"');
    expect(rendered).not.toContain('internalCode=');
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

  it('does not parse request ids or dates as status codes', () => {
    const err: any = new Error(
      'request openai-responses-router-gpt-5.5-20260629T212248675-423575-3858 failed: Upstream provider error'
    );

    logRequestError('/v1/responses', 'req_fake_status_294', err);

    const rendered = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('Unclassified error');
    expect(rendered).toContain('Upstream provider error');
    expect(rendered).toContain('missing status/code');
    expect(rendered).not.toContain('status=294');
    expect(rendered).not.toMatch(/\bstatus=\d{3}\b/);
  });

  it('parses explicit status text without accepting arbitrary three-digit tokens', () => {
    const err: any = new Error(
      'request openai-responses-router-gpt-5.5-20260629T212248675-423575-3858 failed: status=504 code=HTTP_504'
    );

    logRequestError('/v1/responses', 'req_explicit_status_504', err);

    const rendered = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('status=504');
    expect(rendered).not.toContain('status=294');
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

  it('suppresses verbose http.error.meta line for routine 429 logs', () => {
    const previousVerbose = process.env.ROUTECODEX_HTTP_ERROR_META_LOG;
    process.env.ROUTECODEX_HTTP_ERROR_META_LOG = '1';
    try {
      const err: any = new Error('HTTP 429');
      err.statusCode = 429;
      err.code = 'HTTP_429';
      err.rawErrorSnippet = '{"error":{"code":"bad_response_status_code"}}';

      logRequestError('/v1/responses.submit_tool_outputs', 'req_429_meta_suppressed', err);

      const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(rendered.some((line) => line.includes('[http.error.meta]'))).toBe(false);
      expect(rendered.some((line) => line.includes('Rate limited by upstream provider'))).toBe(true);
    } finally {
      if (previousVerbose === undefined) {
        delete process.env.ROUTECODEX_HTTP_ERROR_META_LOG;
      } else {
        process.env.ROUTECODEX_HTTP_ERROR_META_LOG = previousVerbose;
      }
    }
  });

  it('does not print upstream 401 provider payload in primary failure line or http error meta', () => {
    const previousVerbose = process.env.ROUTECODEX_HTTP_ERROR_META_LOG;
    process.env.ROUTECODEX_HTTP_ERROR_META_LOG = '1';
    try {
      const err: any = new Error(
        'HTTP 401: {"error":{"code":"","message":"Invalid token (request id: 202606071512468498407098268d9d6mBARM7HT)","type":"new_api_error"}}'
      );
      err.statusCode = 401;
      err.code = 'HTTP_401';
      err.catalogCode = '401.1002';
      err.catalogKey = 'INVALID_ACCESS_TOKEN';
      err.rawErrorSnippet =
        '{"error":{"code":"new_api_error","message":"Invalid token (request id: 202606071512468498407098268d9d6mBARM7HT)","type":"new_api_error"}}';

      logRequestError('/v1/responses', 'req_401_public_summary', err);

      const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
      expect(rendered).toContain('Upstream authentication failed');
      expect(rendered).toContain('status=401');
      expect(rendered).toContain('code=HTTP_401');
      expect(rendered).toContain('catalogCode=401.1002');
      expect(rendered).toContain('catalogKey=INVALID_ACCESS_TOKEN');
      expect(rendered).not.toContain('Invalid token');
      expect(rendered).not.toContain('202606071512468498407098268d9d6mBARM7HT');
      expect(rendered).not.toContain('new_api_error');
    } finally {
      if (previousVerbose === undefined) {
        delete process.env.ROUTECODEX_HTTP_ERROR_META_LOG;
      } else {
        process.env.ROUTECODEX_HTTP_ERROR_META_LOG = previousVerbose;
      }
    }
  });

  it('does not print upstream 403 provider quota payload in primary failure line or http error meta', () => {
    const previousVerbose = process.env.ROUTECODEX_HTTP_ERROR_META_LOG;
    process.env.ROUTECODEX_HTTP_ERROR_META_LOG = '1';
    try {
      const err: any = new Error(
        'HTTP 403: {"error":{"message":"余额和订阅额度均不足，请充值后再使用","type":"permission_error","code":"insufficient_quota"}}'
      );
      err.statusCode = 403;
      err.code = 'HTTP_403';
      err.catalogCode = '429.2000';
      err.catalogKey = 'INSUFFICIENT_QUOTA';
      err.rawErrorSnippet =
        '{"error":{"message":"余额和订阅额度均不足，请充值后再使用","type":"permission_error","code":"insufficient_quota"}}';

      logRequestError('/v1/responses', 'req_403_public_summary', err);

      const rendered = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
      expect(rendered).toContain('余额和订阅额度均不足，请充值后再使用');
      expect(rendered).toContain('status=403');
      expect(rendered).toContain('code=HTTP_403');
      expect(rendered).toContain('catalogCode=429.2000');
      expect(rendered).toContain('catalogKey=INSUFFICIENT_QUOTA');
      expect(rendered).not.toContain('Upstream authentication failed');
      expect(rendered).not.toContain('permission_error');
    } finally {
      if (previousVerbose === undefined) {
        delete process.env.ROUTECODEX_HTTP_ERROR_META_LOG;
      } else {
        process.env.ROUTECODEX_HTTP_ERROR_META_LOG = previousVerbose;
      }
    }
  });
});
