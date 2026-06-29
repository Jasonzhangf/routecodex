import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const buildServertoolOutcomePlanInputWithNative = jest.fn((input: any) => input);
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
    buildServertoolOutcomePlanInputWithNative,
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
    planServertoolHandlerRuntimeActionWithNative: jest.fn(() => ({
      action: 'return_materialized_result'
    })),
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
  buildServertoolOutcomePlanInput,
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
          action: input?.requiresPendingInjection === true &&
              input?.followupStrategy === 'pending_injection'
            ? 'return_mixed_client_tools_pending_injection'
            : 'invalid_mixed_client_tools_outcome',
          reuseLastExecutionEnvelope: false,
          pendingInjection:
            input?.pendingSessionId && Array.isArray(input?.pendingInjectionMessagesResolved) && input.pendingInjectionMessagesResolved.length > 0
              ? {
                  sessionId: input.pendingSessionId,
                  aliasSessionIds: input.aliasSessionIds ?? [],
                  afterToolCallIds: input.remainingToolCallIds ?? [],
                  messages: input.pendingInjectionMessagesResolved
                }
              : undefined,
          executionFlowId: typeof input?.flowId === 'string' && input.flowId.trim()
            ? input.flowId
            : 'servertool_mixed'
        };
      }
      if (
        input?.useLastExecutionFollowup === true &&
        input?.followupStrategy === 'reuse_last_execution' &&
        input?.lastExecution?.followup
      ) {
        return {
          action: 'reuse_last_execution_followup',
          reuseLastExecutionEnvelope: input?.executedToolCallsLen === 1,
          selectedFollowup: input.lastExecution.followup,
          selectedExecutionEnvelope: input.lastExecution,
          executionFlowId: typeof input?.flowId === 'string' && input.flowId.trim()
            ? input.flowId
            : 'servertool_multi'
        };
      }
      if (input?.resolvedFollowup) {
        return {
          action: 'use_resolved_followup',
          reuseLastExecutionEnvelope: false,
          selectedFollowup: input.resolvedFollowup,
          executionFlowId: typeof input?.flowId === 'string' && input.flowId.trim()
            ? input.flowId
            : 'servertool_multi'
        };
      }
      return {
        action: 'missing_followup_contract',
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
    expect(source).toContain('const clientResponse = args.base;');
    expect(source).not.toContain('structuredClone(args.base)');
    expect(source).not.toContain('args.options.adapterContext && typeof (args.options.adapterContext as any).sessionId ===');
    expect(source).not.toContain('args.options.adapterContext && typeof (args.options.adapterContext as any).conversationId ===');
    expect(source).not.toContain('Array.isArray((args.baseForExecution as any).tool_outputs)');
    expect(source).not.toContain('JSON.parse(JSON.stringify(');
  });

  test('uses native dispatch contract error for invalid mixed-client-tools outcome contract', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'mixed_client_tools',
      followupStrategy: 'reuse_last_execution',
      requiresPendingInjection: false,
      pendingInjectionMessagesResolved: [],
      pendingSessionId: '',
      aliasSessionIds: [],
      remainingToolCallIds: [],
      useLastExecutionFollowup: false,
      useGenericFollowup: false
    });

    expect(() =>
      materializeNativeToolCallExecutionOutcome({
        base: { id: 'base-1' } as any,
        baseForExecution: { id: 'base-1' } as any,
        options: { requestId: 'req-invalid-mixed-1', adapterContext: {} } as any,
        toolCalls: [],
        executionState: {
          executedToolCalls: [],
          executedIds: new Set<string>(),
          executedFlowIds: []
        },
        filterOutExecutedToolCalls: jest.fn(),
        stripToolOutputs: jest.fn(),
        pendingInjectionMessageKinds: []
      })
    ).toThrow('[native-dispatch-contract] invalid_mixed_client_tools_outcome');

    expect(planServertoolExecutionOutcomeRuntimeActionWithNative).toHaveBeenCalledWith({
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: false,
      followupStrategy: 'reuse_last_execution',
      useLastExecutionFollowup: false,
      hasLastExecutionFollowup: false,
      hasResolvedFollowup: false,
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      resolvedFollowup: undefined,
      flowId: undefined,
      pendingSessionId: '',
      aliasSessionIds: [],
      remainingToolCallIds: [],
      pendingInjectionMessagesResolved: []
    });
    expect(planServertoolExecutionDispatchErrorWithNative).toHaveBeenCalledWith({
      kind: 'invalid_mixed_client_tools_outcome',
      requestId: 'req-invalid-mixed-1',
      outcomeMode: 'mixed_client_tools',
      followupStrategy: 'reuse_last_execution',
      requiresPendingInjection: false
    });
  });

  test('uses native dispatch contract error for missing followup contract', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'servertool_only',
      followupStrategy: 'resolved_followup',
      requiresPendingInjection: false,
      pendingInjectionMessagesResolved: [],
      pendingSessionId: '',
      aliasSessionIds: [],
      remainingToolCallIds: [],
      resolvedFollowup: null,
      useLastExecutionFollowup: false,
      useGenericFollowup: true,
      flowId: 'servertool_multi'
    });

    expect(() =>
      materializeNativeToolCallExecutionOutcome({
        base: { id: 'base-2' } as any,
        baseForExecution: { id: 'base-2' } as any,
        options: { requestId: 'req-missing-followup-1', adapterContext: {} } as any,
        toolCalls: [],
        executionState: {
          executedToolCalls: [],
          executedIds: new Set<string>(),
          executedFlowIds: []
        },
        filterOutExecutedToolCalls: jest.fn(),
        stripToolOutputs: jest.fn(),
        pendingInjectionMessageKinds: []
      })
    ).toThrow('[native-dispatch-contract] missing_followup_contract');

    expect(planServertoolExecutionOutcomeRuntimeActionWithNative).toHaveBeenCalledWith({
      outcomeMode: 'servertool_only',
      requiresPendingInjection: false,
      followupStrategy: 'resolved_followup',
      useLastExecutionFollowup: false,
      hasLastExecutionFollowup: false,
      hasResolvedFollowup: false,
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      resolvedFollowup: null,
      flowId: 'servertool_multi',
      pendingSessionId: '',
      aliasSessionIds: [],
      remainingToolCallIds: [],
      pendingInjectionMessagesResolved: []
    });
    expect(planServertoolExecutionDispatchErrorWithNative).toHaveBeenCalledWith({
      kind: 'missing_followup_contract',
      requestId: 'req-missing-followup-1',
      outcomeMode: 'servertool_only',
      followupStrategy: 'resolved_followup',
      useLastExecutionFollowup: false,
      useGenericFollowup: true
    });
  });

  test('uses Rust-owned execution outcome runtime action planning', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'servertool_only',
      followupStrategy: 'reuse_last_execution',
      requiresPendingInjection: false,
      pendingInjectionMessagesResolved: [],
      pendingSessionId: '',
      aliasSessionIds: [],
      remainingToolCallIds: [],
      resolvedFollowup: { requestIdSuffix: ':should_not_win' },
      useLastExecutionFollowup: true,
      useGenericFollowup: false,
      flowId: 'servertool_multi'
    });

    const result = materializeNativeToolCallExecutionOutcome({
      base: { id: 'base-3' } as any,
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
      },
      filterOutExecutedToolCalls: jest.fn(),
      stripToolOutputs: jest.fn(),
      pendingInjectionMessageKinds: []
    });

    expect(buildServertoolOutcomePlanInputWithNative).toHaveBeenCalledWith(
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
      requiresPendingInjection: false,
      followupStrategy: 'reuse_last_execution',
      useLastExecutionFollowup: true,
      hasLastExecutionFollowup: true,
      hasResolvedFollowup: true,
      hasLastExecution: true,
      executedToolCallsLen: 1,
      lastExecution: {
        flowId: 'flow_1',
        followup: { requestIdSuffix: ':reuse_last_execution' },
        context: { kept: true }
      },
      resolvedFollowup: { requestIdSuffix: ':should_not_win' },
      flowId: 'servertool_multi',
      pendingSessionId: '',
      aliasSessionIds: [],
      remainingToolCallIds: [],
      pendingInjectionMessagesResolved: []
    });
    expect(result.execution).toMatchObject({
      flowId: 'servertool_multi',
      followup: {
        requestIdSuffix: ':reuse_last_execution'
      },
      context: {
        kept: true
      }
    });
  });

  test('uses Rust-owned pending-injection projection instead of TS local assembly', () => {
    planServertoolOutcomeWithNative.mockReturnValue({
      outcomeMode: 'mixed_client_tools',
      followupStrategy: 'pending_injection',
      requiresPendingInjection: true,
      pendingInjectionMessagesResolved: [{ role: 'assistant', content: 'queued' }],
      pendingSessionId: 'sess_pending_1',
      aliasSessionIds: ['alias_pending_1'],
      remainingToolCallIds: ['call_pending_2'],
      useLastExecutionFollowup: false,
      useGenericFollowup: false,
      flowId: 'servertool_mixed'
    });

    const filterOutExecutedToolCalls = jest.fn();
    const stripToolOutputs = jest.fn();
    const result = materializeNativeToolCallExecutionOutcome({
      base: { id: 'base-pending-1' } as any,
      baseForExecution: { id: 'base-pending-1' } as any,
      options: { requestId: 'req-pending-injection-1', adapterContext: {} } as any,
      toolCalls: [],
      executionState: {
        executedToolCalls: [],
        executedIds: new Set<string>(),
        executedFlowIds: []
      },
      filterOutExecutedToolCalls,
      stripToolOutputs,
      pendingInjectionMessageKinds: []
    });

    expect(result.execution).toEqual({ flowId: 'servertool_mixed' });
    expect(result.pendingInjection).toEqual({
      sessionId: 'sess_pending_1',
      aliasSessionIds: ['alias_pending_1'],
      afterToolCallIds: ['call_pending_2'],
      messages: [{ role: 'assistant', content: 'queued' }]
    });
    expect(planServertoolExecutionOutcomeRuntimeActionWithNative).toHaveBeenCalledWith({
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: true,
      followupStrategy: 'pending_injection',
      useLastExecutionFollowup: false,
      hasLastExecutionFollowup: false,
      hasResolvedFollowup: false,
      hasLastExecution: false,
      executedToolCallsLen: 0,
      lastExecution: undefined,
      resolvedFollowup: undefined,
      flowId: 'servertool_mixed',
      pendingSessionId: 'sess_pending_1',
      aliasSessionIds: ['alias_pending_1'],
      remainingToolCallIds: ['call_pending_2'],
      pendingInjectionMessagesResolved: [{ role: 'assistant', content: 'queued' }]
    });
    expect(filterOutExecutedToolCalls).toHaveBeenCalledTimes(1);
    expect(stripToolOutputs).toHaveBeenCalledTimes(1);
  });

  test('builds outcome-plan input through Rust owner instead of local TS branch assembly', () => {
    const executionState = {
      executedToolCalls: [],
      executedIds: new Set<string>(),
      executedFlowIds: []
    };

    const input = buildServertoolOutcomePlanInput({
      toolCalls: [{ id: 'call_dispatch_1', name: 'web_search', arguments: '{}' }],
      executionState,
      adapterContext: { sessionId: 'sess_dispatch_1' },
      baseForExecution: { id: 'base-dispatch-1' },
      sessionId: 'sess_dispatch_1',
      conversationId: 'conv_dispatch_1',
      toolOutputs: [{ tool_call_id: 'call_dispatch_1' }],
      pendingInjectionMessageKinds: ['assistant_tool_calls', 'tool_outputs']
    });

    expect(input).toMatchObject({
      toolCalls: [{ id: 'call_dispatch_1', name: 'web_search', arguments: '{}' }],
      executionState,
      adapterContext: { sessionId: 'sess_dispatch_1' },
      baseForExecution: { id: 'base-dispatch-1' },
      sessionId: 'sess_dispatch_1',
      conversationId: 'conv_dispatch_1',
      toolOutputs: [{ tool_call_id: 'call_dispatch_1' }],
      pendingInjectionMessageKinds: ['assistant_tool_calls', 'tool_outputs']
    });
  });
});
