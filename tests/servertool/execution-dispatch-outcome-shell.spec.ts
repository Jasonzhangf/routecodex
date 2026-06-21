import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getServerToolHandler = jest.fn();
const runServertoolHandler = jest.fn();
const materializeServertoolPlannedResult = jest.fn();
const createServertoolExecutionLoopStateFromNative = jest.fn();
const appendExecutedToolRecordFromNative = jest.fn();
const materializeNativeToolCallExecutionOutcomeNative = jest.fn((args: any) => ({
  mode: 'tool_flow',
  finalChatResponse: args.base,
  execution: { flowId: args.options.requestId }
}));
const buildServertoolHandlerErrorToolOutputPayloadWithNative = jest.fn();
const planServertoolExecutionDispatchErrorWithNative = jest.fn();
const planServertoolExecutionLoopEffectWithNative = jest.fn();
const planServertoolExecutionLoopRuntimeActionWithNative = jest.fn();
const planServertoolExecutionOutcomeRuntimeActionWithNative = jest.fn();
const planServertoolOutcomeWithNative = jest.fn();
const buildServertoolOutcomePlanInputWithNative = jest.fn((input: any) => input);

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
  '../../sharedmodule/llmswitch-core/src/servertool/registry.js',
  () => ({
    getServerToolHandler,
    listAdHocRegisteredToolCallHandlerSpecs: jest.fn(() => [])
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
    materializeServertoolPlannedResult,
    runServertoolHandler,
    createServertoolExecutionLoopStateFromNative,
    appendExecutedToolRecordFromNative,
    buildServertoolOutcomePlanInput: jest.fn((input: any) => input),
    materializeNativeToolCallExecutionOutcome: materializeNativeToolCallExecutionOutcomeNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolNoopOutcomeWithNative: jest.fn(),
    planServertoolOutcomeWithNative,
    buildServertoolDispatchPlanInputWithNative: jest.fn((input: any) => input),
    buildServertoolOutcomePlanInputWithNative,
    planServertoolToolCallDispatchWithNative: jest.fn(),
    buildServertoolHandlerErrorToolOutputPayloadWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolExecutionDispatchErrorWithNative,
    planServertoolExecutionLoopEffectWithNative,
    planServertoolExecutionLoopRuntimeActionWithNative,
    planServertoolExecutionOutcomeRuntimeActionWithNative,
    isAdapterClientDisconnectedWithNative: jest.fn(() => false),
    planClientDisconnectWatcherWithNative: jest.fn(() => ({ intervalMs: 50 })),
    planServertoolClientDisconnectedErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] client disconnected',
      details: input ?? {}
    })),
    planServertoolRequiredResponseHookEmptyErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] required response hook empty',
      details: input ?? {}
    })),
    planServertoolStateLoadFailedErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] state load failed',
      details: input ?? {}
    })),
    planServertoolTimeoutErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_TIMEOUT',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] timeout',
      details: input ?? {}
    })),
    planServertoolTimeoutWatcherWithNative: jest.fn(() => ({ armed: false, timeoutMs: 50 })),
    planStopMessageFetchFailedErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] stop message fetch failed',
      details: input ?? {}
    }))
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

const {
  runServertoolIoExecutionQueue
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.js'
);

describe('execution-dispatch-outcome-shell', () => {
  test('execution-dispatch shell stays an IO queue + dispatch facade; outcome materialization owns elsewhere', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts',
        'utf8'
      )
    );

    expect(source).not.toContain('function materializeNativeToolCallExecutionOutcome(');
    expect(source).not.toContain('function buildServertoolOutcomePlanInput(');
    expect(source).not.toContain('planServertoolOutcomeWithNative(');
    expect(source).not.toContain('planServertoolExecutionOutcomeRuntimeActionWithNative(');
    expect(source).not.toContain('function assertDispatchExecutionMode(');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolExecutionDispatchErrorWithNative.mockImplementation((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: `[native-dispatch-contract] ${String(input?.kind ?? 'unknown')}`,
      details: input ?? {}
    }));
    createServertoolExecutionLoopStateFromNative.mockReturnValue({
      executedToolCalls: [],
      executedIds: new Set<string>(),
      executedFlowIds: []
    });
    appendExecutedToolRecordFromNative.mockImplementation((state: any, toolCall: any, execution?: any) => {
      state.executedToolCalls.push({ toolCall, ...(execution ? { execution } : {}) });
      state.executedIds.add(toolCall.id);
      if (execution?.flowId) {
        state.executedFlowIds.push(execution.flowId);
        state.lastExecution = execution;
      }
    });
    planServertoolExecutionLoopRuntimeActionWithNative.mockImplementation((input: any) => {
      if (input?.hasHandlerEntry !== true || input?.triggerMode !== 'tool_call') {
        return { action: 'skip_non_tool_call_handler' };
      }
      if (
        typeof input?.nativeExecutionMode === 'string' &&
        typeof input?.tsExecutionMode === 'string' &&
        input.nativeExecutionMode.trim() !== '' &&
        input.tsExecutionMode.trim() !== '' &&
        input.nativeExecutionMode !== input.tsExecutionMode
      ) {
        return { action: 'throw_dispatch_spec_mismatch' };
      }
      if (input?.hasMaterializedResult === true) {
        return { action: 'apply_materialized_result' };
      }
      if (input?.hasHandlerError === true) {
        return { action: 'apply_handler_error_tool_output' };
      }
      return { action: 'continue_without_effect' };
    });
    planServertoolExecutionLoopEffectWithNative.mockImplementation((input: any) => {
      if (input?.mode === 'handler_error') {
        return {
          toolCall: input.toolCall,
          execution: {
            flowId: `${String(input?.toolCall?.name ?? '').trim()}_error`
          }
        };
      }
      return {
        toolCall: {
          ...input.toolCall,
          executionMode: 'noop',
          stripAfterExecute: true
        },
        execution: {
          flowId: String(input?.noopFlowId ?? 'continue_execution_flow'),
          ...(input?.noopFollowup !== undefined ? { followup: input.noopFollowup } : {}),
          ...(input?.noopExecutionContext !== undefined ? { context: input.noopExecutionContext } : {})
        }
      };
    });
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
                  ...(Array.isArray(input.aliasSessionIds) && input.aliasSessionIds.length > 0
                    ? { aliasSessionIds: input.aliasSessionIds }
                    : {}),
                  afterToolCallIds: Array.isArray(input.remainingToolCallIds)
                    ? input.remainingToolCallIds
                    : [],
                  messages: input.pendingInjectionMessagesResolved
                }
              : undefined,
          executionFlowId: String(input?.flowId ?? 'servertool_mixed')
        };
      }
      if (
        input?.useLastExecutionFollowup === true &&
        input?.followupStrategy === 'reuse_last_execution' &&
        input?.hasLastExecutionFollowup === true
      ) {
        return {
          action: 'reuse_last_execution_followup',
          reuseLastExecutionEnvelope:
            input?.hasLastExecution === true && Number(input?.executedToolCallsLen ?? 0) === 1,
          selectedFollowup: input?.lastExecution?.followup,
          selectedExecutionEnvelope:
            input?.hasLastExecution === true && Number(input?.executedToolCallsLen ?? 0) === 1
              ? input?.lastExecution
              : undefined,
          executionFlowId: String(input?.flowId ?? 'servertool_multi')
        };
      }
      if (input?.hasResolvedFollowup === true) {
        return {
          action: 'use_resolved_followup',
          reuseLastExecutionEnvelope: false,
          selectedFollowup: input?.resolvedFollowup,
          executionFlowId: String(input?.flowId ?? 'servertool_multi')
        };
      }
      return {
        action: 'missing_followup_contract',
        reuseLastExecutionEnvelope: false,
        executionFlowId: String(input?.flowId ?? 'servertool_multi')
      };
    });
    createServertoolExecutionLoopStateFromNative.mockReturnValue({
      executedToolCalls: [],
      executedIds: new Set<string>(),
      executedFlowIds: []
    });
    appendExecutedToolRecordFromNative.mockImplementation((state: any, toolCall: any, execution?: any) => {
      state.executedToolCalls.push({
        toolCall,
        ...(execution ? { execution } : {})
      });
      state.executedIds.add(toolCall.id);
      if (execution?.flowId) {
        state.executedFlowIds.push(execution.flowId);
        state.lastExecution = execution;
      }
    });
  });

  test('uses native tool-output payload builder for handler errors instead of TS append/stringify', async () => {
    getServerToolHandler.mockReturnValue({
      trigger: 'tool_call',
      registration: { executionMode: 'guarded' },
      handler: jest.fn()
    });
    runServertoolHandler.mockRejectedValue(new Error('boom-from-execution-shell'));
    materializeServertoolPlannedResult.mockResolvedValue(null);
    buildServertoolHandlerErrorToolOutputPayloadWithNative.mockImplementation((input: any) => ({
      ...(input.base ?? {}),
      tool_outputs: [
        {
          tool_call_id: input.toolCallId,
          name: input.toolName,
          content: JSON.stringify({
            ok: false,
            tool: input.toolName,
            message: input.message,
            retryable: input.retryable ?? true
          })
        }
      ]
    }));

    const baseForExecution: Record<string, unknown> = {
      id: 'chatcmpl-test'
    };
    const result = await runServertoolIoExecutionQueue({
      dispatchPlan: {
        executableToolCalls: [
          {
            id: 'call_fail_1',
            name: 'failfast_test_tool',
            arguments: '{}',
            executionMode: 'guarded',
            stripAfterExecute: true
          }
        ],
        noopToolCalls: []
      },
      options: {
        requestId: 'req-execution-dispatch-error-1',
        adapterContext: {}
      },
      contextBase: {
        adapterContext: {},
        requestId: 'req-execution-dispatch-error-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      baseForExecution: baseForExecution as any
    });

    expect(buildServertoolHandlerErrorToolOutputPayloadWithNative).toHaveBeenCalledTimes(1);
    expect(buildServertoolHandlerErrorToolOutputPayloadWithNative.mock.calls[0]?.[0]).toMatchObject({
      toolCallId: 'call_fail_1',
      toolName: 'failfast_test_tool',
      message: 'boom-from-execution-shell'
    });
    expect((buildServertoolHandlerErrorToolOutputPayloadWithNative.mock.calls[0]?.[0] as any)?.base?.id).toBe(
      'chatcmpl-test'
    );
    expect((baseForExecution as any).tool_outputs).toEqual([
      {
        tool_call_id: 'call_fail_1',
        name: 'failfast_test_tool',
        content: JSON.stringify({
          ok: false,
          tool: 'failfast_test_tool',
          message: 'boom-from-execution-shell',
          retryable: true
        })
      }
    ]);
    expect(planServertoolExecutionLoopEffectWithNative).toHaveBeenCalledWith({
      mode: 'handler_error',
      toolCall: {
        id: 'call_fail_1',
        name: 'failfast_test_tool',
        arguments: '{}',
        executionMode: 'guarded',
        stripAfterExecute: true
      }
    });
    expect(result.executedFlowIds).toEqual(['failfast_test_tool_error']);
    expect(planServertoolExecutionLoopRuntimeActionWithNative).toHaveBeenNthCalledWith(1, {
      hasHandlerEntry: true,
      triggerMode: 'tool_call',
      nativeExecutionMode: 'guarded',
      tsExecutionMode: 'guarded',
      hasMaterializedResult: false,
      hasHandlerError: false
    });
    expect(planServertoolExecutionLoopRuntimeActionWithNative).toHaveBeenNthCalledWith(2, {
      hasHandlerEntry: true,
      triggerMode: 'tool_call',
      hasMaterializedResult: false,
      hasHandlerError: true
    });
  });

  test('uses native dispatch contract error for execution-mode mismatch inside runtime loop', async () => {
    getServerToolHandler.mockReturnValue({
      trigger: 'tool_call',
      registration: { executionMode: 'legacy' },
      handler: jest.fn()
    });

    await expect(
      runServertoolIoExecutionQueue({
        dispatchPlan: {
          executableToolCalls: [
            {
              id: 'call_mismatch_1',
              name: 'web_search',
              arguments: '{}',
              executionMode: 'guarded',
              stripAfterExecute: true
            }
          ],
          noopToolCalls: []
        },
        options: {
          requestId: 'req-dispatch-mismatch-1',
          adapterContext: {}
        } as any,
        contextBase: {
          adapterContext: {},
          requestId: 'req-dispatch-mismatch-1',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses'
        } as any,
        baseForExecution: { id: 'chatcmpl-mismatch' } as any
      })
    ).rejects.toThrow('[native-dispatch-contract] dispatch_spec_mismatch');

    expect(createServertoolExecutionLoopStateFromNative).toHaveBeenCalledTimes(1);
    expect(planServertoolExecutionLoopRuntimeActionWithNative).toHaveBeenCalledWith({
      hasHandlerEntry: true,
      triggerMode: 'tool_call',
      nativeExecutionMode: 'legacy',
      tsExecutionMode: 'guarded',
      hasMaterializedResult: false,
      hasHandlerError: false
    });
    expect(planServertoolExecutionDispatchErrorWithNative).toHaveBeenCalledWith({
      kind: 'dispatch_spec_mismatch',
      requestId: 'req-dispatch-mismatch-1',
      toolName: 'web_search',
      nativeExecutionMode: 'legacy',
      tsExecutionMode: 'guarded'
    });
  });


  test('uses Rust-owned execution loop runtime action planning to skip non-tool-call handlers', async () => {
    getServerToolHandler.mockReturnValue({
      trigger: 'auto',
      registration: { executionMode: 'guarded' },
      handler: jest.fn()
    });

    const result = await runServertoolIoExecutionQueue({
      dispatchPlan: {
        executableToolCalls: [
          {
            id: 'call_skip_1',
            name: 'skip_tool',
            arguments: '{}',
            executionMode: 'guarded',
            stripAfterExecute: true
          }
        ],
        noopToolCalls: []
      },
      options: {
        requestId: 'req-execution-loop-skip-1',
        adapterContext: {}
      } as any,
      contextBase: {
        adapterContext: {},
        requestId: 'req-execution-loop-skip-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      baseForExecution: { id: 'chatcmpl-skip' } as any
    });

    expect(planServertoolExecutionLoopRuntimeActionWithNative).toHaveBeenCalledWith({
      hasHandlerEntry: true,
      triggerMode: 'auto',
      nativeExecutionMode: 'guarded',
      tsExecutionMode: 'guarded',
      hasMaterializedResult: false,
      hasHandlerError: false
    });
    expect(runServertoolHandler).not.toHaveBeenCalled();
    expect(result.executedToolCalls).toEqual([]);
  });

  test('uses Rust-owned execution loop effect planning for noop tool-call records', async () => {
    const { planServertoolNoopOutcomeWithNative } = await import(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js'
    );
    (planServertoolNoopOutcomeWithNative as jest.Mock).mockReturnValue({
      chatResponse: {
        id: 'chatcmpl-noop',
        tool_outputs: [{ tool_call_id: 'call_continue_1', name: 'continue_execution', content: '{"ok":true}' }]
      },
      flowId: 'continue_execution_flow',
      followup: { requestIdSuffix: ':continue_execution_followup' },
      executionContext: { continue_execution: { visibleSummary: '继续执行' } }
    });

    const result = await runServertoolIoExecutionQueue({
      dispatchPlan: {
        executableToolCalls: [],
        noopToolCalls: [
          {
            id: 'call_continue_1',
            name: 'continue_execution',
            arguments: '{}',
            executionMode: 'guarded',
            stripAfterExecute: false
          }
        ]
      },
      options: {
        requestId: 'req-execution-loop-noop-1',
        adapterContext: {}
      } as any,
      contextBase: {
        adapterContext: {},
        requestId: 'req-execution-loop-noop-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      baseForExecution: { id: 'chatcmpl-base' } as any
    });

    expect(planServertoolExecutionLoopEffectWithNative).toHaveBeenCalledWith({
      mode: 'noop',
      toolCall: {
        id: 'call_continue_1',
        name: 'continue_execution',
        arguments: '{}',
        executionMode: 'guarded',
        stripAfterExecute: false
      },
      noopFlowId: 'continue_execution_flow',
      noopFollowup: { requestIdSuffix: ':continue_execution_followup' },
      noopExecutionContext: { continue_execution: { visibleSummary: '继续执行' } }
    });
    expect(result.executedToolCalls[0]).toMatchObject({
      toolCall: {
        id: 'call_continue_1',
        name: 'continue_execution',
        arguments: '{}',
        executionMode: 'noop',
        stripAfterExecute: true
      },
      execution: {
        flowId: 'continue_execution_flow',
        followup: { requestIdSuffix: ':continue_execution_followup' },
        context: { continue_execution: { visibleSummary: '继续执行' } }
      }
    });
  });
});
