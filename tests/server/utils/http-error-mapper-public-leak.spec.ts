import {
  mapErrorToHttp,
  mapErrorToPublicLogSummary,
} from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper public payload leak guard', () => {
  it('projects provider business errors without wrapping them as 502', () => {
    const mapped = mapErrorToHttp(Object.assign(
      new Error('[provider] Upstream provider returned business error: 该模型访问量过大，请稍后再试'),
      {
        code: 'PROVIDER_BUSINESS_ERROR',
        upstreamCode: 'provider_status_2056',
        statusCode: 429,
        response: {
          data: {
            error: {
              code: 'provider_status_2056',
              message: '该模型访问量过大，请稍后再试',
              status: 429
            }
          },
          status: 429
        }
      }
    ));

    expect(mapped.status).toBe(429);
    expect(mapped.body.error).toMatchObject({
      message: '该模型访问量过大，请稍后再试',
      code: 'provider_status_2056'
    });
  });

  it('masks provider diagnostics from upstream 400 payloads', () => {
    const mapped = mapErrorToHttp({
      message: 'HTTP 400: {"error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"bad_request_error\\",\\"message\\":\\"Error from provider (MiniMax): invalid params, tool result id not found (2013)\\",\\"http_code\\":\\"400\\"},\\"request_id\\":\\"066c94854d8da9b51651e2d687289e42\\"}","code":"HTTP_400"}}',
      code: 'HTTP_400',
      status: 400,
      requestId: 'openai-responses-opencode-zen-free.key1-minimax-m3-free-20260601T184003969-246178-1902',
      providerKey: 'opencode-zen-free.key1.minimax-m3-free',
      providerType: 'openai',
      routeName: 'search',
      details: {
        providerKey: 'opencode-zen-free.key1.minimax-m3-free',
        providerType: 'openai',
        routeName: 'search',
        upstreamMessage: 'Error from provider (MiniMax): invalid params, tool result id not found (2013)',
        status: 400
      }
    });

    const publicJson = JSON.stringify(mapped.body);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toMatchObject({
      message: 'Upstream rejected the request',
      code: 'HTTP_400',
      request_id: 'openai-responses-provider-20260601T184003969-246178-1902'
    });
    expect(publicJson).not.toContain('MiniMax');
    expect(publicJson).not.toContain('minimax');
    expect(publicJson).not.toContain('provider_key');
    expect(publicJson).not.toContain('upstream_message');
    expect(publicJson).not.toContain('tool result id not found');
  });

  it('projects upstream 401 provider payload to public stage-log summary', () => {
    const err = Object.assign(
      new Error(
        'HTTP 401: {"error":{"code":"","message":"Invalid token (request id: 202606071512468498407098268d9d6mBARM7HT)","type":"new_api_error"}}'
      ),
      {
        statusCode: 401,
        code: 'HTTP_401',
        rawErrorSnippet:
          '{"error":{"code":"new_api_error","message":"Invalid token (request id: 202606071512468498407098268d9d6mBARM7HT)","type":"new_api_error"}}',
      }
    );

    const summary = mapErrorToPublicLogSummary(err);

    expect(summary).toBe('Upstream provider error');
    expect(summary).not.toContain('Invalid token');
    expect(summary).not.toContain('202606071512468498407098268d9d6mBARM7HT');
    expect(summary).not.toContain('new_api_error');
    expect(summary).not.toContain('HTTP_401');
  });

  it('projects upstream 403 quota payload to public stage-log summary', () => {
    const err = Object.assign(
      new Error(
        'HTTP 403: {"error":{"message":"余额和订阅额度均不足，请充值后再使用","type":"permission_error","code":"insufficient_quota"}}'
      ),
      {
        statusCode: 403,
        code: 'HTTP_403',
        rawErrorSnippet:
          '{"error":{"message":"余额和订阅额度均不足，请充值后再使用","type":"permission_error","code":"insufficient_quota"}}',
      }
    );

    const summary = mapErrorToPublicLogSummary(err);

    expect(summary).toBe('Upstream provider error');
    expect(summary).not.toContain('余额和订阅额度均不足');
    expect(summary).not.toContain('permission_error');
    expect(summary).not.toContain('insufficient_quota');
    expect(summary).not.toContain('HTTP_403');
  });
});
