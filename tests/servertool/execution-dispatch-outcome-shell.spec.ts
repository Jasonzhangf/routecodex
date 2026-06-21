import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getServerToolHandler = jest.fn();
const runServertoolHandler = jest.fn();
const materializeServertoolPlannedResult = jest.fn();
const buildServertoolHandlerErrorToolOutputPayloadWithNative = jest.fn();
const planServertoolExecutionDispatchErrorWithNative = jest.fn();
const planServertoolExecutionLoopEffectWithNative = jest.fn();
const planServertoolExecutionLoopRuntimeActionWithNative = jest.fn();
const planServertoolExecutionOutcomeRuntimeActionWithNative = jest.fn();
const planServertoolOutcomeWithNative = jest.fn();
const buildServertoolOutcomePlanInputWithNative = jest.fn((input: any) => input);
const createServertoolExecutionLoopStateWithNative = jest.fn();
const appendServertoolExecutedRecordWithNative = jest.fn();

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
    runServertoolHandler
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
    createServertoolExecutionLoopStateWithNative,
    appendServertoolExecutedRecordWithNative
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
  materializeNativeToolCallExecutionOutcome,
  runServertoolIoExecutionQueue
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.js'
);

describe('execution-dispatch-outcome-shell', () => {
  test('execution outcome thin shell forwards adapter/base context to native outcome-plan builder', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('adapterContext: args.options.adapterContext');
    expect(source).toContain('baseForExecution: args.baseForExecution');
    expect(source).toContain('const clientResponse = structuredClone(args.base);');
    expect(source).not.toContain('args.options.adapterContext && typeof (args.options.adapterContext as any).sessionId ===');
    expect(source).not.toContain('args.options.adapterContext && typeof (args.options.adapterContext as any).conversationId ===');
    expect(source).not.toContain('Array.isArray((args.baseForExecution as any).tool_outputs)');
    expect(source).not.toContain('JSON.parse(JSON.stringify(');
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
    planServertoolExecutionLoopRuntimeActionWithNative.mockImplementation((input: any) => {
      if (input?.hasHandlerEntry !== true || input?.triggerMode !== 'tool_call') {
        return { action: 'skip_non_tool_call_handler' };
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
    createServertoolExecutionLoopStateWithNative.mockReturnValue({
      executedToolCalls: [],
      executedIds: [],
      executedFlowIds: []
    });
    appendServertoolExecutedRecordWithNative.mockImplementation((input: any) => {
      const state = input?.state ?? {
        executedToolCalls: [],
        executedIds: [],
        executedFlowIds: []
      };
      const nextExecution = input?.execution
        ? {
            flowId: String(input.execution.flowId ?? '').trim(),
            ...(input.execution.followup !== undefined ? { followup: input.execution.followup } : {}),
            ...(input.execution.context !== undefined ? { context: input.execution.context } : {})
          }
        : undefined;
      const nextIds = [...(state.executedIds ?? [])];
      const toolCallId = String(input?.toolCall?.id ?? '').trim();
      if (toolCallId && !nextIds.includes(toolCallId)) {
        nextIds.push(toolCallId);
      }
      return {
        executedToolCalls: [
          ...(state.executedToolCalls ?? []),
          {
            toolCall: input.toolCall,
            ...(nextExecution ? { execution: nextExecution } : {})
          }
        ],
        executedIds: nextIds,
        executedFlowIds: nextExecution?.flowId
          ? [...(state.executedFlowIds ?? []), nextExecution.flowId]
          : [...(state.executedFlowIds ?? [])],
        ...(nextExecution ? { lastExecution: nextExecution } : state?.lastExecution ? { lastExecution: state.lastExecution } : {})
      };
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

    expect(createServertoolExecutionLoopStateWithNative).toHaveBeenCalledTimes(1);
    expect(planServertoolExecutionDispatchErrorWithNative).toHaveBeenCalledWith({
      kind: 'dispatch_spec_mismatch',
      requestId: 'req-dispatch-mismatch-1',
      toolName: 'web_search',
      nativeExecutionMode: 'guarded',
      tsExecutionMode: 'legacy'
    });
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
