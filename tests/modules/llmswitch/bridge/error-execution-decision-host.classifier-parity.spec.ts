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
