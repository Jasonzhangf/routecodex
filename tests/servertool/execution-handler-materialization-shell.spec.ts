import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const buildServertoolOutcomePlanInputWithNativeMock = jest.fn((input: any) => input);
const planServertoolOutcomeWithNative = jest.fn();
const planServertoolExecutionOutcomeRuntimeActionWithNative = jest.fn();
const planServertoolExecutionDispatchErrorWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/provider-protocol-error.js',
  () => ({
    ProviderProtocolError: class ProviderProtocolError extends Error {
      code: string;
      category: string;
      details: Record<string, unknown>;
      status?: number;

      constructor(
        message: string,
        options: {
          code?: string;
          category?: string;
          details?: Record<string, unknown>;
        } = {}
      ) {
        super(message);
        this.name = 'ProviderProtocolError';
        this.code = options.code ?? 'SERVERTOOL_HANDLER_FAILED';
        this.category = options.category ?? 'INTERNAL_ERROR';
        this.details = options.details ?? {};
      }
    }
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    buildServertoolOutcomePlanInputWithNative: buildServertoolOutcomePlanInputWithNativeMock,
    getDefaultServertoolSkeletonDocumentWithNative: jest.fn(() => ({})),
    normalizeServertoolRegistrationSpecWithNative: jest.fn(() => null),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => ({ entries: [] })),
    planServertoolBuiltinHandlerEntryWithNative: jest.fn(() => ({ action: 'return_none' })),
    planServertoolBuiltinHandlerNamesWithNative: jest.fn(() => ({ names: [] })),
    planServertoolBuiltinHandlerRecordEntriesWithNative: jest.fn(() => ({ entries: [] })),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(() => ({ action: 'return_none' })),
    planServertoolSkeletonDerivedConfigWithNative: jest.fn(() => ({ toolSpecList: [] })),
    resolveServertoolRegisteredNameWithNative: jest.fn(() => false),
    resolveServertoolBuiltinHandlerEntryWithNative: jest.fn(() => null),
    resolveServertoolToolSpecWithNative: jest.fn(() => null),
    planServertoolOutcomeWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    appendServertoolExecutedRecordWithNative: jest.fn((input: any) => input?.state ?? {}),
    createServertoolExecutionLoopStateWithNative: jest.fn(() => ({
      executedToolCalls: [],
      executedIds: [],
      executedFlowIds: []
    })),
    planServertoolHandlerContractErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: `[native-handler-contract] ${String(input?.kind ?? 'unknown')}`,
      details: input ?? {}
    })),
    planServertoolHandlerRuntimeActionForPlannedWithNative: jest.fn(() => ({
      action: 'return_handler_result'
    })),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(() => null),
    parseServertoolCliProjectionToolArgumentsWithNative: jest.fn(() => ({})),
    planServertoolExecutionDispatchErrorWithNative,
    planServertoolExecutionOutcomeRuntimeActionWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.js',
  () => ({
    replaceJsonObjectInPlace: jest.fn((target: any, next: any) => {
      for (const key of Object.keys(target)) {
        delete target[key];
      }
      Object.assign(target, next);
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan: jest.fn((plan: any) => {
      const error = new Error(plan?.message ?? 'servertool dispatch error') as Error & {
        code?: string;
        category?: string;
        status?: number;
        details?: unknown;
      };
      error.code = plan?.code;
      error.category = plan?.category;
      error.status = plan?.status;
      error.details = plan?.details;
      return error;
    })
  })
);

const {
  materializeNativeToolCallExecutionOutcome
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js'
);

describe('execution-handler-materialization-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolExecutionDispatchErrorWithNative.mockImplementation((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: `[native-dispatch-contract] ${String(input?.kind ?? 'unknown')}`,
      details: input ?? {}
    }));
    planServertoolExecutionOutcomeRuntimeActionWithNative.mockImplementation((input: any) => {
      if (input?.outcomeMode === 'mixed_client_tools') {
        return {
          action: 'invalid_mixed_client_tools_outcome',
          reuseLastExecutionEnvelope: false,
          executionFlowId: typeof input?.flowId === 'string' && input.flowId.trim()
            ? input.flowId
            : 'servertool_mixed'
        };
      }
      if (input?.hasLastExecution === true || input?.hasResolvedFollowup === true || Number(input?.executedToolCallsLen ?? 0) > 0) {
        return {
          action: 'return_execution_contract',
          reuseLastExecutionEnvelope: false,
          executionFlowId: typeof input?.flowId === 'string' && input.flowId.trim()
            ? input.flowId
            : 'servertool_multi'
        };
      }
      return {
        action: 'missing_servertool_execution_contract',
        reuseLastExecutionEnvelope: false,
        executionFlowId: typeof input?.flowId === 'string' && input.flowId.trim()
          ? input.flowId
          : 'servertool_multi'
      };
    });
  });

  test('outcome materialization shell forwards adapter/base context to native outcome-plan builder', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('adapterContext: args.options.adapterContext');
    expect(source).toContain('baseForExecution: args.baseForExecution');
    expect(source).toContain('const outcomePlan = planServertoolOutcomeWithNative(');
    expect(source).toContain('buildServertoolOutcomePlanInputWithNative({');
    expect(source).not.toContain('const outcomePlanInput =');
    expect(source).toContain('throw createServertoolProviderProtocolErrorFromPlan(');
    expect(source).toContain('planServertoolExecutionDispatchErrorWithNative({');
    expect(source).not.toContain('function throwServertoolExecutionDispatchError(');
    expect(source).toContain('finalChatResponse: args.baseForExecution');
    expect(source).not.toContain('export const buildServertoolOutcomePlanInput =');
    expect(source).not.toContain('structuredClone(args.base)');
    expect(source).not.toContain('base: JsonObject;');
    expect(source).not.toContain('filterOutExecutedToolCalls:');
    expect(source).not.toContain('stripToolOutputs:');
    expect(source).not.toContain('args.options.adapterContext && typeof (args.options.adapterContext as any).sessionId ===');
    expect(source).not.toContain('args.options.adapterContext && typeof (args.options.adapterContext as any).conversationId ===');
    expect(source).not.toContain('Array.isArray((args.baseForExecution as any).tool_outputs)');
    expect(source).not.toContain('JSON.parse(JSON.stringify(');
  });

  test('uses native dispatch contract error for invalid mixed-client-tools outcome contract', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: false,
      remainingToolCallIds: [],
    });

    expect(() =>
      materializeNativeToolCallExecutionOutcome({
        baseForExecution: { id: 'base-1' } as any,
        options: { requestId: 'req-invalid-mixed-1', adapterContext: {} } as any,
        toolCalls: [],
        executionState: {
          executedToolCalls: [],
          executedIds: new Set<string>(),
          executedFlowIds: []
        }
      })
    ).toThrow('[native-dispatch-contract] invalid_mixed_client_tools_outcome');

    expect(planServertoolExecutionOutcomeRuntimeActionWithNative).toHaveBeenCalledWith({
      outcomeMode: 'mixed_client_tools',
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      flowId: undefined
    });
    expect(planServertoolExecutionDispatchErrorWithNative).toHaveBeenCalledWith({
      kind: 'invalid_mixed_client_tools_outcome',
      requestId: 'req-invalid-mixed-1',
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: false
    });
  });

  test('uses native dispatch contract error for missing followup contract', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
      remainingToolCallIds: [],
      flowId: 'servertool_multi'
    });

    expect(() =>
      materializeNativeToolCallExecutionOutcome({
        baseForExecution: { id: 'base-2' } as any,
        options: { requestId: 'req-missing-followup-1', adapterContext: {} } as any,
        toolCalls: [],
        executionState: {
          executedToolCalls: [],
          executedIds: new Set<string>(),
          executedFlowIds: []
        }
      })
    ).toThrow('[native-dispatch-contract] missing_servertool_execution_contract');

    expect(planServertoolExecutionOutcomeRuntimeActionWithNative).toHaveBeenCalledWith({
      outcomeMode: 'servertool_only',
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      flowId: 'servertool_multi'
    });
    expect(planServertoolExecutionDispatchErrorWithNative).toHaveBeenCalledWith({
      kind: 'missing_servertool_execution_contract',
      requestId: 'req-missing-followup-1',
      outcomeMode: 'servertool_only'
    });
  });

  test('uses Rust-owned execution outcome runtime action planning', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
      remainingToolCallIds: [],
      flowId: 'servertool_multi'
    });

    const result = materializeNativeToolCallExecutionOutcome({
      baseForExecution: { id: 'base-3' } as any,
      options: { requestId: 'req-outcome-runtime-action-1', adapterContext: {} } as any,
      toolCalls: [],
      executionState: {
        executedToolCalls: [{ toolCall: { id: 'call_1', name: 'tool_1', arguments: '{}' } }] as any,
        executedIds: new Set<string>(),
        executedFlowIds: ['flow_1'],
        lastExecution: {
          flowId: 'flow_1',
          followup: { requestIdSuffix: ':reuse_last_execution' },
          context: { kept: true }
        } as any
      }
    });

    expect(buildServertoolOutcomePlanInputWithNativeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls: [],
        executionState: expect.objectContaining({
          executedToolCalls: [{ toolCall: { id: 'call_1', name: 'tool_1', arguments: '{}' } }],
          executedIds: expect.any(Set),
          executedFlowIds: ['flow_1'],
          lastExecution: {
            flowId: 'flow_1',
            followup: { requestIdSuffix: ':reuse_last_execution' },
            context: { kept: true }
          }
        }),
        adapterContext: {},
        baseForExecution: { id: 'base-3' }
      })
    );
    expect(planServertoolExecutionOutcomeRuntimeActionWithNative).toHaveBeenCalledWith({
      outcomeMode: 'servertool_only',
      hasLastExecution: true,
      executedToolCallsLen: 1,
      lastExecution: {
        flowId: 'flow_1',
        followup: { requestIdSuffix: ':reuse_last_execution' },
        context: { kept: true }
      },
      flowId: 'servertool_multi'
    });
    expect(result.execution).toMatchObject({
      flowId: 'servertool_multi'
    });
  });

  test('rejects retired pending-injection projection', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: true,
      remainingToolCallIds: ['call_pending_2'],
      flowId: 'servertool_mixed'
    });

    expect(() =>
      materializeNativeToolCallExecutionOutcome({
        baseForExecution: { id: 'base-pending-1' } as any,
        options: { requestId: 'req-pending-injection-1', adapterContext: {} } as any,
        toolCalls: [],
        executionState: {
          executedToolCalls: [],
          executedIds: new Set<string>(),
          executedFlowIds: []
        }
      })
    ).toThrow('[native-dispatch-contract] invalid_mixed_client_tools_outcome');
    expect(planServertoolExecutionOutcomeRuntimeActionWithNative).toHaveBeenCalledWith({
      outcomeMode: 'mixed_client_tools',
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      flowId: 'servertool_mixed'
    });
  });

  test('builds outcome-plan input through Rust owner directly', () => {
    const executionState = {
      executedToolCalls: [],
      executedIds: new Set<string>(),
      executedFlowIds: []
    };

    const input = buildServertoolOutcomePlanInputWithNativeMock({
      toolCalls: [{ id: 'call_dispatch_1', name: 'web_search', arguments: '{}' }],
      executionState,
      adapterContext: { sessionId: 'sess_dispatch_1' },
      baseForExecution: { id: 'base-dispatch-1' }
    });

    expect(input).toMatchObject({
      toolCalls: [{ id: 'call_dispatch_1', name: 'web_search', arguments: '{}' }],
      executionState,
      adapterContext: { sessionId: 'sess_dispatch_1' },
      baseForExecution: { id: 'base-dispatch-1' }
    });
  });
});
