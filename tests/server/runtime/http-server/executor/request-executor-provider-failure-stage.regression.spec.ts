import { describe, expect, it } from '@jest/globals';

const { __requestExecutorTestables } = await import('../../../../../src/server/runtime/http-server/request-executor.js');

describe('request executor provider failure stage regression', () => {
  it('uses explicit stage parameter instead of fallback semantics for runtime resolve errors', () => {
    const plan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('followup failed before send'), {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        reason: 'followup failed before send'
      },
      stage: 'provider.runtime_resolve'
    });

    expect(plan).toEqual({
      errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'CLIENT_INJECT_FAILED',
      statusCode: 502,
      stageHint: 'provider.runtime_resolve'
    });
  });

  it('still upgrades provider.send followup codes into explicit provider.followup stage', () => {
    const plan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('followup client inject failed'), {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        reason: 'followup client inject failed'
      },
      stage: 'provider.send'
    });

    expect(plan).toEqual({
      errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'CLIENT_INJECT_FAILED',
      statusCode: 502,
      stageHint: 'provider.followup'
    });
  });

  it('preserves provider.send source stage and leaves SSE classification to Rust', () => {
    const plan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(
        new Error('Anthropic SSE error event [1305] 该模型当前访问量过大，请您稍后再试'),
        {
          code: 'SSE_DECODE_ERROR',
          upstreamCode: 'anthropic_sse_to_json_failed',
          statusCode: 429
        }
      ),
      retryError: {
        statusCode: 429,
        errorCode: 'SSE_DECODE_ERROR',
        upstreamCode: 'anthropic_sse_to_json_failed',
        reason: 'Anthropic SSE error event [1305] 该模型当前访问量过大，请您稍后再试'
      },
      stage: 'provider.send'
    });

    expect(plan).toEqual({
      errorCode: 'SSE_DECODE_ERROR',
      upstreamCode: 'ANTHROPIC_SSE_TO_JSON_FAILED',
      statusCode: 429,
      stageHint: 'provider.send'
    });
  });
});
