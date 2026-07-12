import { describe, expect, test } from '@jest/globals';
import { classifyErrorErr02HostCapturedNative } from '../../../../src/modules/llmswitch/bridge/error-execution-decision-host';
import { resolveProviderFailureClassification } from '../../../../src/providers/core/runtime/provider-failure-policy-impl';

const cases = [
  {
    name: 'upstream stream incomplete',
    input: {
      stage: 'provider.send', statusCode: 502,
      errorCode: 'UPSTREAM_STREAM_INCOMPLETE', upstreamCode: 'UPSTREAM_STREAM_INCOMPLETE',
      reason: 'stream closed before response.completed', errorMessage: 'stream closed before response.completed',
    },
  },
  {
    name: 'upstream stream idle timeout',
    input: {
      stage: 'provider.send', statusCode: 504,
      errorCode: 'UPSTREAM_STREAM_IDLE_TIMEOUT', upstreamCode: 'UPSTREAM_STREAM_IDLE_TIMEOUT',
      reason: 'UPSTREAM_STREAM_IDLE_TIMEOUT', errorMessage: 'UPSTREAM_STREAM_IDLE_TIMEOUT',
    },
  },
  {
    name: 'client disconnect 499',
    input: {
      stage: 'provider.send', statusCode: 499, errorCode: 'HTTP_499', upstreamCode: 'HTTP_499',
      reason: 'client abort request', errorMessage: 'HTTP 499', detailUpstreamMessage: 'client abort request',
    },
  },
  {
    name: 'recoverable host empty assistant',
    input: { stage: 'host.response_contract', errorCode: 'EMPTY_ASSISTANT_RESPONSE' },
  },
  {
    name: 'non-provider followup',
    input: { stage: 'provider.followup', statusCode: 502, errorCode: 'HTTP_502' },
  },
  ...[401, 402, 403, 404].map((statusCode) => ({
    name: `terminal HTTP ${statusCode}`,
    input: { stage: 'provider.send', statusCode, errorCode: `HTTP_${statusCode}`, reason: 'provider rejected request' },
  })),
  {
    name: 'plain malformed response',
    input: { stage: 'provider.send', statusCode: 502, errorCode: 'MALFORMED_RESPONSE', reason: 'invalid provider response' },
  },
  {
    name: 'malformed request',
    input: { stage: 'provider.send', statusCode: 400, errorCode: 'MALFORMED_REQUEST', reason: 'invalid request payload' },
  },
  {
    name: 'client tool args invalid',
    input: { stage: 'provider.send', statusCode: 502, errorCode: 'CLIENT_TOOL_ARGS_INVALID', reason: 'tool arguments invalid' },
  },
  {
    name: 'context length exceeded',
    input: { stage: 'provider.send', statusCode: 400, errorCode: 'CONTEXT_LENGTH_EXCEEDED', reason: 'maximum context length exceeded' },
  },
  {
    name: 'HTTP2 stream cancel',
    input: { stage: 'provider.send', statusCode: 502, errorCode: 'ERR_HTTP2_STREAM_CANCEL', reason: 'stream cancelled' },
  },
  {
    name: 'GLM 514 business error',
    input: { stage: 'provider.send', statusCode: 200, errorCode: '514', reason: 'glm business error (514)' },
  },
  {
    name: 'provider business 2013 saturation',
    input: {
      stage: 'provider.send', statusCode: 200, errorCode: 'MALFORMED_RESPONSE',
      detailUpstreamCode: 'PROVIDER_STATUS_2013', providerStatusCode: 2013,
      reason: 'Token Plan 当前请求量较高，请稍后重试',
    },
  },
  {
    name: 'provider business 2013 context length',
    input: {
      stage: 'provider.send', statusCode: 200, errorCode: 'MALFORMED_RESPONSE',
      detailUpstreamCode: 'PROVIDER_STATUS_2013', providerStatusCode: 2013,
      detailReason: 'context_length_exceeded', reason: 'context_length_exceeded',
    },
  },
  {
    name: 'provider business 2056 rotation overload',
    input: {
      stage: 'provider.send', statusCode: 200, errorCode: 'MALFORMED_RESPONSE',
      detailUpstreamCode: 'PROVIDER_STATUS_2056', reason: 'usage limit exceeded',
    },
  },
  {
    name: 'nested server error',
    input: {
      stage: 'provider.send', statusCode: 500, errorCode: 'MALFORMED_RESPONSE',
      responseErrorType: 'server_error', responseErrorCode: 'server_error', reason: 'server error',
    },
  },
  {
    name: 'HTTP 200 JSON instead of SSE',
    input: {
      stage: 'provider.send', statusCode: 200, errorCode: 'MALFORMED_RESPONSE',
      responseErrorMessage: 'returned JSON instead of SSE', reason: 'returned JSON instead of SSE',
    },
  },
] as const;

describe('ErrorErr02 Rust classifier parity', () => {
  for (const entry of cases) {
    test(entry.name, () => {
      const native = classifyErrorErr02HostCapturedNative(entry.input);
      const error = {
        message: entry.input.errorMessage,
        name: 'errorName' in entry.input ? entry.input.errorName : undefined,
        code: entry.input.errorCode,
        upstreamCode: entry.input.upstreamCode,
        statusCode: entry.input.statusCode,
        details: {
          reason: 'detailReason' in entry.input ? entry.input.detailReason : undefined,
          upstreamCode: 'detailUpstreamCode' in entry.input ? entry.input.detailUpstreamCode : undefined,
          upstreamMessage: 'detailUpstreamMessage' in entry.input ? entry.input.detailUpstreamMessage : undefined,
          providerStatusCode: 'providerStatusCode' in entry.input ? entry.input.providerStatusCode : undefined,
        },
        response: {
          data: {
            error: {
              code: 'responseErrorCode' in entry.input ? entry.input.responseErrorCode : undefined,
              type: 'responseErrorType' in entry.input ? entry.input.responseErrorType : undefined,
              param: 'responseErrorParam' in entry.input ? entry.input.responseErrorParam : undefined,
              message: 'responseErrorMessage' in entry.input ? entry.input.responseErrorMessage : undefined,
            },
          },
        },
      };
      const legacy = resolveProviderFailureClassification({
        error,
        stage: entry.input.stage,
        statusCode: entry.input.statusCode,
        errorCode: entry.input.errorCode,
        upstreamCode: entry.input.upstreamCode,
        reason: entry.input.reason,
      });
      expect(native.classification).toBe(legacy);
    });
  }
});
