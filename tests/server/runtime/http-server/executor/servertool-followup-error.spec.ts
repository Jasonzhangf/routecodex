import { describe, expect, it } from '@jest/globals';
import {
  compactFollowupLogReason,
  finalizeServerToolBridgeConvertError,
  finalizeServerToolFollowupConvertError,
  markServerToolFollowupError
} from '../../../../../src/server/runtime/http-server/executor/servertool-followup-error.js';

describe('servertool followup error helper', () => {
  it('marks followup errors with provider.followup stage and default status', () => {
    const error = Object.assign(new Error('HTTP 401: invalid token'), {
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      details: {
        reason: 'HTTP 401: invalid token'
      }
    });

    const matched = markServerToolFollowupError({
      error,
      requestId: 'req_followup_error_1',
      defaultStatus: 502
    });

    expect(matched).toBe(true);
    expect((error as any).requestExecutorProviderErrorStage).toBe('provider.followup');
    expect((error as any).status).toBe(502);
    expect((error as any).statusCode).toBe(502);
  });

  it('compacts verbose followup reasons without losing HTTP code signal', () => {
    expect(compactFollowupLogReason('HTTP 429: upstream overloaded, retry later')).toBe('HTTP_429');
    expect(compactFollowupLogReason('<html><body>bad gateway</body></html>')).toBe('UPSTREAM_HTML_ERROR');
  });


  it('builds single-source convert.bridge.error stage payload for followup failures', () => {
    const error = Object.assign(new Error('followup payload missing'), {
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'client_inject_failed',
      details: {
        reason: 'HTTP 401: invalid token'
      }
    });

    const plan = finalizeServerToolFollowupConvertError({
      error,
      requestId: 'req_followup_error_2',
      defaultStatus: 502,
      message: 'followup payload missing'
    });

    expect(plan).toEqual({
      matched: true,
      stageDetails: {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        reason: 'HTTP_401',
        message: 'followup payload missing'
      }
    });
    expect((error as any).requestExecutorProviderErrorStage).toBe('provider.followup');
    expect((error as any).statusCode).toBe(502);
  });

  it('normalizes bridge SSE decode failures into a single stage payload', () => {
    const error = Object.assign(new Error('failed to convert sse payload'), {
      code: 'HTTP_502',
      upstreamCode: 'ANTHROPIC_SSE_TO_JSON_FAILED'
    });

    const plan = finalizeServerToolBridgeConvertError({
      error,
      requestId: 'req_bridge_error_1',
      message: 'failed to convert sse payload',
      isSseDecodeError: true,
      code: 'HTTP_502',
      upstreamCode: 'ANTHROPIC_SSE_TO_JSON_FAILED',
      detailReason: 'Internal Network Failure'
    });

    expect(plan).toEqual({
      handled: true,
      stageDetails: {
        code: 'HTTP_502',
        upstreamCode: 'ANTHROPIC_SSE_TO_JSON_FAILED',
        reason: 'Internal Network Failure',
        message: 'failed to convert sse payload'
      }
    });
    expect((error as any).requestExecutorProviderErrorStage).toBe('provider.sse_decode');
  });
});
