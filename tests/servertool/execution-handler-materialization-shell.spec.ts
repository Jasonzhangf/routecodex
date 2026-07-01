import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const buildServertoolOutcomePlanInputWithNativeMock = jest.fn((input: any) => input);
const planServertoolOutcomeWithNative = jest.fn();
const planServertoolExecutionOutcomeMaterializationWithNative = jest.fn();
const planServertoolHandlerMaterializationForPlannedWithNative = jest.fn();

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
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(() => null),
    parseServertoolCliProjectionToolArgumentsWithNative: jest.fn(() => ({})),
    planServertoolExecutionOutcomeMaterializationWithNative,
    planServertoolHandlerMaterializationForPlannedWithNative
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
  materializeNativeToolCallExecutionOutcome,
  materializeServertoolPlannedResult
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js'
);

describe('execution-handler-materialization-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolExecutionOutcomeMaterializationWithNative.mockImplementation((input: any) => {
      if (input?.outcomeMode === 'mixed_client_tools') {
        return {
          action: 'throw_dispatch_error',
          errorPlan: {
            code: 'SERVERTOOL_HANDLER_FAILED',
            category: 'INTERNAL_ERROR',
            status: 500,
            message: '[native-dispatch-contract] invalid_mixed_client_tools_outcome',
            details: {
              requestId: input?.requestId,
              outcomeMode: input?.outcomeMode,
              requiresPendingInjection: input?.requiresPendingInjection
            }
          }
        };
      }
      if (input?.hasLastExecution === true || Number(input?.executedToolCallsLen ?? 0) > 0) {
        return {
          action: 'return_tool_flow',
          resultMode: 'tool_flow',
          executionFlowId: input?.flowId ?? 'servertool_multi'
        };
      }
      return {
        action: 'throw_dispatch_error',
        errorPlan: {
          code: 'SERVERTOOL_HANDLER_FAILED',
          category: 'INTERNAL_ERROR',
          status: 500,
          message: '[native-dispatch-contract] missing_servertool_execution_contract',
          details: {
            requestId: input?.requestId,
            outcomeMode: input?.outcomeMode
          }
        }
      };
    });
    planServertoolHandlerMaterializationForPlannedWithNative.mockReturnValue({
      action: 'return_handler_result'
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
    expect(source).toContain('planServertoolExecutionOutcomeMaterializationWithNative({');
    expect(source).not.toContain("if (materializationPlan.action === 'throw_dispatch_error')");
    expect(source).toContain('switch (materializationPlan.action)');
    expect(source).not.toContain('materializationPlan as { action: unknown }');
    expect(source).not.toContain('const materializationAction = materializationPlan.action');
    expect(source).not.toContain('Boolean(args.executionState.lastExecution)');
    expect(source).toContain('hasLastExecution: args.executionState.lastExecution != null');
    expect(source).not.toContain('planServertoolExecutionDispatchErrorWithNative({');
    expect(source).toContain('planServertoolHandlerMaterializationForPlannedWithNative(');
    expect(source).not.toContain('planServertoolHandlerContractErrorWithNative(');
    expect(source).not.toContain("actionPlan.action === 'invalid_plan_missing_finalize'");
    expect(source).not.toContain("actionPlan.action === 'invalid_plan_result'");
    expect(source).not.toContain("if (actionPlan.action === 'finalize_without_backend')");
    expect(source).not.toContain("if (actionPlan.action === 'throw_handler_error')");
    expect(source).toContain('switch (actionPlan.action)');
    expect(source).not.toContain('actionPlan as { action: string }');
    expect(source).not.toContain("outcomeRuntimeActionPlan.action === 'invalid_mixed_client_tools_outcome'");
    expect(source).not.toContain("outcomeRuntimeActionPlan.action === 'missing_servertool_execution_contract'");
    expect(source).not.toContain('record.executionFlowId.trim()');
    expect(source).not.toContain("input.outcomeMode === 'mixed_client_tools'");
    expect(source).not.toContain('function throwServertoolExecutionDispatchError(');
    expect(source).toContain('mode: materializationPlan.resultMode');
    expect(source).not.toContain("mode: 'tool_flow'");
    expect(source).toContain('invalid execution outcome materialization action');
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
    const nativeSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts',
        'utf8'
      )
    );
    expect(nativeSource).toContain('planServertoolExecutionOutcomeMaterializationJson native returned invalid resultMode');
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
          executedIds: [],
          executedFlowIds: []
        }
      })
    ).toThrow('[native-dispatch-contract] invalid_mixed_client_tools_outcome');

    expect(planServertoolExecutionOutcomeMaterializationWithNative).toHaveBeenCalledWith({
      requestId: 'req-invalid-mixed-1',
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: false,
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      flowId: undefined
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
          executedIds: [],
          executedFlowIds: []
        }
      })
    ).toThrow('[native-dispatch-contract] missing_servertool_execution_contract');

    expect(planServertoolExecutionOutcomeMaterializationWithNative).toHaveBeenCalledWith({
      requestId: 'req-missing-followup-1',
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      flowId: 'servertool_multi'
    });
  });

  test('uses Rust-owned execution outcome materialization planning', () => {
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
        executedIds: [],
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
          executedIds: expect.any(Array),
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
    expect(planServertoolExecutionOutcomeMaterializationWithNative).toHaveBeenCalledWith({
      requestId: 'req-outcome-runtime-action-1',
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
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

  test('treats null last execution as absent without truthiness coercion', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
      remainingToolCallIds: [],
      flowId: 'servertool_multi'
    });

    expect(() =>
      materializeNativeToolCallExecutionOutcome({
        baseForExecution: { id: 'base-4' } as any,
        options: { requestId: 'req-null-last-execution-1', adapterContext: {} } as any,
        toolCalls: [],
        executionState: {
          executedToolCalls: [],
          executedIds: [],
          executedFlowIds: [],
          lastExecution: null as any
        }
      })
    ).toThrow('[native-dispatch-contract] missing_servertool_execution_contract');

    expect(planServertoolExecutionOutcomeMaterializationWithNative).toHaveBeenCalledWith({
      requestId: 'req-null-last-execution-1',
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: null,
      flowId: 'servertool_multi'
    });
  });

  test('execution outcome materialization fails fast for unknown native action', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
      remainingToolCallIds: [],
      flowId: 'servertool_multi'
    });
    planServertoolExecutionOutcomeMaterializationWithNative.mockReturnValue({
      action: 'unknown_outcome_action'
    });

    expect(() =>
      materializeNativeToolCallExecutionOutcome({
        baseForExecution: { id: 'base-unknown-outcome-action' } as any,
        options: { requestId: 'req-unknown-outcome-action', adapterContext: {} } as any,
        toolCalls: [],
        executionState: {
          executedToolCalls: [],
          executedIds: [],
          executedFlowIds: []
        }
      })
    ).toThrow('[servertool] invalid execution outcome materialization action');
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
          executedIds: [],
          executedFlowIds: []
        }
      })
    ).toThrow('[native-dispatch-contract] invalid_mixed_client_tools_outcome');
    expect(planServertoolExecutionOutcomeMaterializationWithNative).toHaveBeenCalledWith({
      requestId: 'req-pending-injection-1',
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: true,
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      flowId: 'servertool_mixed'
    });
  });

  test('builds outcome-plan input through Rust owner directly', () => {
    const executionState = {
      executedToolCalls: [],
      executedIds: [],
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

  test('planned handler materialization executes finalize only when Rust plan requests it', async () => {
    const finalized = {
      chatResponse: { id: 'finalized-chat' },
      execution: { flowId: 'flow-finalized' }
    };
    const finalize = jest.fn(async () => finalized);
    const planned = {
      flowId: 'flow-plan',
      finalize
    };
    planServertoolHandlerMaterializationForPlannedWithNative.mockReturnValue({
      action: 'finalize_without_backend'
    });

    await expect(
      materializeServertoolPlannedResult(planned as any, {
        requestId: 'req-finalize-plan',
        adapterContext: {},
      } as any)
    ).resolves.toBe(finalized);

    expect(planServertoolHandlerMaterializationForPlannedWithNative).toHaveBeenCalledWith(
      planned,
      'req-finalize-plan'
    );
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  test('planned handler materialization throws Rust-owned error plan for invalid handler plan', async () => {
    const planned = { flowId: 'missing-finalize' };
    planServertoolHandlerMaterializationForPlannedWithNative.mockReturnValue({
      action: 'throw_handler_error',
      errorPlan: {
        code: 'SERVERTOOL_HANDLER_FAILED',
        category: 'INTERNAL_ERROR',
        status: 500,
        message: '[native-handler-contract] invalid_handler_plan_missing_finalize',
        details: {
          requestId: 'req-invalid-plan'
        }
      }
    });

    await expect(
      materializeServertoolPlannedResult(planned as any, {
        requestId: 'req-invalid-plan',
        adapterContext: {},
      } as any)
    ).rejects.toThrow('[native-handler-contract] invalid_handler_plan_missing_finalize');
  });

  test('planned handler materialization returns handler result when Rust plan accepts it', async () => {
    const planned = {
      chatResponse: { id: 'handler-result-chat' },
      execution: { flowId: 'flow-handler-result' }
    };
    planServertoolHandlerMaterializationForPlannedWithNative.mockReturnValue({
      action: 'return_handler_result'
    });

    await expect(
      materializeServertoolPlannedResult(planned as any, {
        requestId: 'req-return-result',
        adapterContext: {},
      } as any)
    ).resolves.toBe(planned);
  });

  test('planned handler materialization fails fast for unknown native action', async () => {
    planServertoolHandlerMaterializationForPlannedWithNative.mockReturnValue({
      action: 'unknown_handler_action'
    });

    await expect(
      materializeServertoolPlannedResult({ chatResponse: { id: 'unknown-action' } } as any, {
        requestId: 'req-unknown-handler-action',
        adapterContext: {},
      } as any)
    ).rejects.toThrow('[servertool] invalid handler materialization action');
  });
});
