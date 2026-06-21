import { describe, expect, jest, test } from '@jest/globals';

const planFollowupRuntimeActionWithNative = jest.fn();
const planFollowupAutoLimitErrorWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planFollowupAutoLimitErrorWithNative,
    planFollowupExecutionModeWithNative: jest.fn(() => ({ executionMode: 'reenter' })),
    planFollowupMaterializationWithNative: jest.fn(() => ({
      entryEndpoint: '/v1/responses',
      payloadSource: 'none'
    })),
    planFollowupRuntimeActionWithNative,
    planFollowupRuntimeMetadataWithNative: jest.fn(() => ({
      rootSet: {},
      rootDelete: [],
      runtimeSet: {}
    }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/provider-protocol-error.js',
  () => ({
    ProviderProtocolError: class ProviderProtocolError extends Error {
      code: string;
      category: string;
      details: Record<string, unknown>;
      status?: number;

      constructor(message: string, options: any = {}) {
        super(message);
        this.name = 'ProviderProtocolError';
        this.code = String(options?.code ?? '');
        this.category = String(options?.category ?? '');
        this.details = (options?.details ?? {}) as Record<string, unknown>;
      }
    }
  })
);

const { assertAutoLimitNotExceeded } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.js'
);

describe('backend-route-runtime-block', () => {
  test('projects followup auto-limit error through native plan', () => {
    planFollowupRuntimeActionWithNative.mockReturnValue({
      flowId: 'continue_execution_flow',
      isStopMessageFlow: false,
      loopPayloadSource: 'none',
      autoLimit: {
        exceeded: true,
        status: 502,
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        category: 'INTERNAL_ERROR',
        reason: 'followup_auto_limit_hit',
        repeatCount: 3
      },
      clientInjectMetadata: { force: false }
    });
    planFollowupAutoLimitErrorWithNative.mockReturnValue({
      message: '[servertool] followup auto limit reached before stopless contract was satisfied',
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR',
      status: 502,
      details: {
        flowId: 'continue_execution_flow',
        requestId: 'req-auto-limit',
        repeatCount: 3,
        reason: 'followup_auto_limit_hit'
      }
    });

    let thrown: unknown;
    try {
      assertAutoLimitNotExceeded({
        flowId: 'continue_execution_flow',
        decision: {
          flowId: 'continue_execution_flow',
          outcomeMode: 'reenter',
          noFollowup: false,
          autoLimit: true,
          flowOnlyLoopLimit: false,
          clientInjectOnly: false,
          clearStateOnFollowupFailure: false,
          seedLoopPayload: false,
          ignoreRequiresActionFollowup: false
        },
        loopState: {
          flowId: 'continue_execution_flow',
          repeatCount: 3
        },
        requestId: 'req-auto-limit'
      });
    } catch (error) {
      thrown = error;
    }

    expect(planFollowupAutoLimitErrorWithNative).toHaveBeenCalledWith({
      flowId: 'continue_execution_flow',
      requestId: 'req-auto-limit',
      repeatCount: 3,
      reason: 'followup_auto_limit_hit',
      status: 502,
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR'
    });
    expect(thrown).toMatchObject({
      message: '[servertool] followup auto limit reached before stopless contract was satisfied',
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR',
      status: 502,
      details: {
        flowId: 'continue_execution_flow',
        requestId: 'req-auto-limit',
        repeatCount: 3,
        reason: 'followup_auto_limit_hit'
      }
    });
  });
});
