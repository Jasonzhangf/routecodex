import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planFollowupExecutionModeWithNative = jest.fn();
const planFollowupRuntimeActionWithNative = jest.fn();
const planFollowupAutoLimitErrorWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planFollowupAutoLimitErrorWithNative,
    planFollowupExecutionModeWithNative,
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

const { applyClientInjectOnlyMetadata, assertAutoLimitNotExceeded, resolveFollowupExecutionMode } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.js'
);

describe('backend-route-runtime-block', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('passes followup execution metadata through native contract', () => {
    planFollowupExecutionModeWithNative.mockReturnValue({ executionMode: 'client_inject_only' });

    const executionMode = resolveFollowupExecutionMode({
      flowId: 'continue_execution_flow',
      decision: {
        flowId: 'continue_execution_flow',
        outcomeMode: 'reenter',
        noFollowup: false,
        autoLimit: false,
        flowOnlyLoopLimit: false,
        clientInjectOnly: false,
        clearStateOnFollowupFailure: false,
        seedLoopPayload: false,
        ignoreRequiresActionFollowup: false
      },
      metadata: {
        clientInjectOnly: ' true ',
        clientInjectSource: ' servertool.continue_execution '
      } as any
    });

    expect(executionMode).toBe('client_inject_only');
    expect(planFollowupExecutionModeWithNative).toHaveBeenCalledWith({
      flowId: 'continue_execution_flow',
      decision: {
        outcomeMode: 'reenter',
        noFollowup: false,
        clientInjectOnly: false
      },
      metadata: {
        clientInjectOnly: ' true ',
        clientInjectSource: ' servertool.continue_execution '
      },
      metadataClientInjectOnly: false
    });
  });

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

  test('passes followup runtime metadata through native contract before forcing client inject fields', () => {
    let capturedInput: unknown;
    planFollowupRuntimeActionWithNative.mockImplementation((input: unknown) => {
      capturedInput = JSON.parse(JSON.stringify(input));
      return {
        flowId: 'continue_execution_flow',
        isStopMessageFlow: false,
        loopPayloadSource: 'none',
        autoLimit: { exceeded: false },
        clientInjectMetadata: {
          force: true,
          source: 'servertool.continue_execution'
        }
      };
    });

    const metadata = {
      clientInjectOnly: ' false ',
      clientInjectSource: ' servertool.followup ',
      clientInjectText: '  old text  '
    } as any;
    const result = applyClientInjectOnlyMetadata({
      flowId: 'continue_execution_flow',
      decision: {
        flowId: 'continue_execution_flow',
        outcomeMode: 'client_inject_only',
        noFollowup: false,
        autoLimit: false,
        flowOnlyLoopLimit: false,
        clientInjectOnly: true,
        clearStateOnFollowupFailure: false,
        seedLoopPayload: false,
        ignoreRequiresActionFollowup: false
      },
      metadata,
      defaultText: '继续执行',
      normalizeClientInjectText: (value) => String(value).trim()
    });

    expect(result).toEqual({ forced: true });
    expect(capturedInput).toEqual({
      flowId: 'continue_execution_flow',
      decision: {
        outcomeMode: 'client_inject_only',
        noFollowup: false,
        autoLimit: false,
        clientInjectOnly: true,
        seedLoopPayload: false
      },
      metadata: {
        clientInjectOnly: ' false ',
        clientInjectSource: ' servertool.followup ',
        clientInjectText: '  old text  '
      },
      metadataClientInjectOnly: false,
      hasFollowupPayloadRaw: false
    });
    expect(metadata.clientInjectOnly).toBe(true);
    expect(metadata.clientInjectText).toBe('old text');
    expect(metadata.clientInjectSource).toBe(' servertool.followup ');
  });
});
