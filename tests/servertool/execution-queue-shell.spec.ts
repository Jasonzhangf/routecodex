import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getServerToolHandler = jest.fn();
const materializeServertoolPlannedResult = jest.fn();
const createServertoolExecutionLoopStateWithNative = jest.fn();
const appendServertoolExecutedRecordWithNative = jest.fn();
const buildServertoolHandlerErrorToolOutputPayloadWithNative = jest.fn();
const planServertoolExecutionDispatchErrorWithNative = jest.fn();
const planServertoolExecutionLoopEffectWithNative = jest.fn();
const planServertoolExecutionLoopRuntimeActionWithNative = jest.fn();
const runStoplessBuiltinHandlerForRuntimeWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js',
  () => ({
    getServerToolHandler
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
    materializeServertoolPlannedResult
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolNoopOutcomeWithNative: jest.fn(),
    buildServertoolDispatchPlanInputWithNative: jest.fn((input: any) => input),
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
    createServertoolExecutionLoopStateWithNative,
    appendServertoolExecutedRecordWithNative,
    runStoplessBuiltinHandlerForRuntimeWithNative
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
      const error = new Error(plan?.message ?? 'servertool dispatch error');
      (error as Error & { code?: string; category?: string; status?: number; details?: unknown }).code =
        plan?.code;
      (error as Error & { code?: string; category?: string; status?: number; details?: unknown }).category =
        plan?.category;
      (error as Error & { code?: string; category?: string; status?: number; details?: unknown }).status =
        plan?.status;
      (error as Error & { code?: string; category?: string; status?: number; details?: unknown }).details =
        plan?.details;
      return error;
    })
  })
);

const { runServertoolIoExecutionQueue } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js'
);

describe('execution-queue-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createServertoolExecutionLoopStateWithNative.mockReturnValue({
      executedToolCalls: [],
      executedIds: [],
      executedFlowIds: []
    });
    appendServertoolExecutedRecordWithNative.mockImplementation((input: any) => {
      const state = input?.state ?? { executedToolCalls: [], executedIds: [], executedFlowIds: [] };
      const toolCall = input?.toolCall;
      const execution = input?.execution;
      const next = {
        ...state,
        executedToolCalls: [...state.executedToolCalls, { toolCall, ...(execution ? { execution } : {}) }],
        executedIds: [...state.executedIds, toolCall.id],
        executedFlowIds: [...state.executedFlowIds]
      };
      if (execution?.flowId) {
        next.executedFlowIds.push(execution.flowId);
        next.lastExecution = execution;
      }
      return next;
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
    planServertoolExecutionDispatchErrorWithNative.mockImplementation((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: `[native-dispatch-contract] ${String(input?.kind ?? 'unknown')}`,
      details: input ?? {}
    }));
    planServertoolExecutionLoopEffectWithNative.mockImplementation((input: any) => ({
      toolCall: {
        ...input.toolCall,
        executionMode: 'noop',
        stripAfterExecute: true
      },
      execution: {
        flowId: `${String(input?.toolCall?.name ?? '').trim()}_effect`
      },
      handlerErrorMessage:
        typeof input?.handlerErrorMessage === 'string'
          ? input.handlerErrorMessage.trim() || 'unknown'
          : typeof input?.handlerErrorMessage?.message === 'string'
            ? input.handlerErrorMessage.message.trim() || 'unknown'
          : 'unknown'
    }));
    materializeServertoolPlannedResult.mockResolvedValue({
      chatResponse: { ok: true },
      execution: { flowId: 'flow-1' }
    });
    runStoplessBuiltinHandlerForRuntimeWithNative.mockResolvedValue({
      finalize: jest.fn(),
      flowId: 'flow-1'
    });
    getServerToolHandler.mockReturnValue({
      trigger: 'tool_call',
      registration: { executionMode: 'guarded' },
      execution: {
        kind: 'builtin',
        builtinName: 'web_search'
      }
    });
  });

  test('moves execution queue owner into a dedicated shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('runServertoolIoExecutionQueue');
    expect(source).toContain('planServertoolExecutionLoopRuntimeActionWithNative');
    expect(source).toContain('switch (initialLoopActionPlan.action)');
    expect(source).toContain('switch (resultLoopActionPlan.action)');
    expect(source).not.toContain('const initialLoopAction = initialLoopActionPlan.action');
    expect(source).not.toContain('const resultLoopAction = resultLoopActionPlan.action');
    expect(source).not.toContain("if (initialLoopActionPlan.action === 'skip_non_tool_call_handler')");
    expect(source).not.toContain("if (initialLoopActionPlan.action === 'throw_dispatch_spec_mismatch')");
    expect(source).not.toContain("if (resultLoopActionPlan.action === 'apply_materialized_result')");
    expect(source).not.toContain("if (resultLoopActionPlan.action === 'apply_handler_error_tool_output')");
    expect(source).toContain('createServertoolProviderProtocolErrorFromPlan');
    expect(source).not.toContain('errorEffectPlan.handlerErrorMessage as string');
    expect(source).toContain('message: errorEffectPlan.handlerErrorMessage');
    expect(source).not.toContain("String(lastErr ?? 'unknown')");
    expect(source).not.toContain("lastErr instanceof Error ? lastErr.message : String");
    expect(source).not.toContain('lastErr instanceof Error ? lastErr.message : lastErr');
    expect(source).not.toContain('Boolean(lastErr)');
    expect(source).not.toContain('Boolean(entry)');
    expect(source).not.toContain('Boolean(result)');
    expect(source).not.toContain('planned ? await materializeServertoolPlannedResult');
    expect(source).not.toContain("nativeExecutionMode: entry?.registration.executionMode ?? ''");
    expect(source).not.toContain("toolCall: errorEffectPlan.toolCall as NativeServertoolExecutedRecord['toolCall']");
    expect(source).not.toContain('execution: errorEffectPlan.execution as ServerToolExecution');
    expect(source).not.toContain("toolCall: noopEffectPlan.toolCall as NativeServertoolExecutedRecord['toolCall']");
    expect(source).not.toContain('execution: noopEffectPlan.execution as ServerToolExecution');
    expect(source).not.toContain('result.chatResponse as JsonObject');
    expect(source).toContain('replaceJsonObjectInPlace(args.baseForExecution, result.chatResponse)');
    expect(source).not.toContain('noopResult.chatResponse as JsonObject');
    expect(source).toContain('replaceJsonObjectInPlace(args.baseForExecution, noopResult.chatResponse)');
    expect(source).not.toContain('buildServertoolHandlerErrorToolOutputPayloadWithNative({\n          base: args.baseForExecution as Record<string, unknown>,\n          toolCallId: toolCall.id,\n          toolName: toolCall.name,\n          message: errorEffectPlan.handlerErrorMessage\n        }) as JsonObject');
    expect(source).not.toContain('base: args.baseForExecution as Record<string, unknown>');
    expect(source).toContain('const toolOutputPayload = buildServertoolHandlerErrorToolOutputPayloadWithNative({');
    expect(source).toContain('base: args.baseForExecution');
    expect(source).toContain('hasHandlerEntry: entry != null');
    expect(source).toContain('nativeExecutionMode: entry.registration.executionMode');
    expect(source).toContain('planned != null ? await materializeServertoolPlannedResult');
    expect(source).toContain('hasMaterializedResult: result != null');
    expect(source).toContain('handlerErrorMessage: lastErr');
    expect(source).toContain('toolCall: errorEffectPlan.toolCall');
    expect(source).toContain('execution: errorEffectPlan.execution');
    expect(source).toContain('toolCall: noopEffectPlan.toolCall');
    expect(source).toContain('execution: noopEffectPlan.execution');
    expect(source).not.toContain('buildServertoolDispatchPlanInputWithNative');
    expect(source).not.toContain('String(initialLoopActionPlan.action)');
    expect(source).not.toContain('String(resultLoopActionPlan.action)');
  });

  test('fails fast on unknown initial native loop action without reading action payload in TS', async () => {
    planServertoolExecutionLoopRuntimeActionWithNative.mockReturnValueOnce({
      action: 'unknown_initial_action'
    });

    await expect(
      runServertoolIoExecutionQueue({
        dispatchPlan: {
          executableToolCalls: [
            {
              id: 'call-invalid-initial',
              name: 'web_search',
              arguments: '{}',
              executionMode: 'guarded',
              stripAfterExecute: false
            }
          ],
          noopToolCalls: []
        } as any,
        options: { requestId: 'req-invalid-initial' } as any,
        contextBase: { base: {}, toolCalls: [], adapterContext: {}, requestId: 'req-invalid-initial', entryEndpoint: 'openai', providerProtocol: 'openai-chat' } as any,
        baseForExecution: {} as any
      })
    ).rejects.toThrow('[servertool] invalid execution loop initial action');

    expect(runStoplessBuiltinHandlerForRuntimeWithNative).not.toHaveBeenCalled();
    expect(materializeServertoolPlannedResult).not.toHaveBeenCalled();
    expect(appendServertoolExecutedRecordWithNative).not.toHaveBeenCalled();
  });

  test('fails fast on unknown result native loop action without reading action payload in TS', async () => {
    planServertoolExecutionLoopRuntimeActionWithNative
      .mockReturnValueOnce({ action: 'continue_without_effect' })
      .mockReturnValueOnce({ action: 'unknown_result_action' });
    materializeServertoolPlannedResult.mockResolvedValue(null);

    await expect(
      runServertoolIoExecutionQueue({
        dispatchPlan: {
          executableToolCalls: [
            {
              id: 'call-invalid-result',
              name: 'web_search',
              arguments: '{}',
              executionMode: 'guarded',
              stripAfterExecute: false
            }
          ],
          noopToolCalls: []
        } as any,
        options: { requestId: 'req-invalid-result' } as any,
        contextBase: { base: {}, toolCalls: [], adapterContext: {}, requestId: 'req-invalid-result', entryEndpoint: 'openai', providerProtocol: 'openai-chat' } as any,
        baseForExecution: {} as any
      })
    ).rejects.toThrow('[servertool] invalid execution loop result action');

    expect(runStoplessBuiltinHandlerForRuntimeWithNative).toHaveBeenCalledTimes(1);
    expect(materializeServertoolPlannedResult).toHaveBeenCalledTimes(1);
    expect(appendServertoolExecutedRecordWithNative).not.toHaveBeenCalled();
  });

  test('executes materialized handler result and records execution', async () => {
    const state = await runServertoolIoExecutionQueue({
      dispatchPlan: {
        executableToolCalls: [
          {
            id: 'call-1',
            name: 'web_search',
            arguments: '{}',
            executionMode: 'guarded',
            stripAfterExecute: false
          }
        ],
        noopToolCalls: []
      } as any,
      options: { requestId: 'req-1' } as any,
      contextBase: { base: { ok: true }, toolCalls: [], adapterContext: {}, requestId: 'req-1', entryEndpoint: 'openai', providerProtocol: 'openai-chat' } as any,
      baseForExecution: { ok: true } as any
    });

    expect(state.executedToolCalls).toHaveLength(1);
    expect(runStoplessBuiltinHandlerForRuntimeWithNative).toHaveBeenCalledWith({
      name: 'web_search',
      base: expect.objectContaining({ ok: true }),
      requestId: 'req-1',
      runtimeMetadata: null
    });
    expect(materializeServertoolPlannedResult).toHaveBeenCalled();
    expect(appendServertoolExecutedRecordWithNative).toHaveBeenCalled();
  });

  test('passes falsy thrown handler errors as explicit error presence to native runtime plan', async () => {
    runStoplessBuiltinHandlerForRuntimeWithNative.mockRejectedValue('');
    materializeServertoolPlannedResult.mockResolvedValue(null);
    buildServertoolHandlerErrorToolOutputPayloadWithNative.mockImplementation((input: any) => ({
      ...(input.base ?? {}),
      tool_outputs: [{ tool_call_id: input.toolCallId, name: input.toolName, content: input.message }]
    }));

    await runServertoolIoExecutionQueue({
      dispatchPlan: {
        executableToolCalls: [
          {
            id: 'call-falsy-error',
            name: 'web_search',
            arguments: '{}',
            executionMode: 'guarded',
            stripAfterExecute: true
          }
        ],
        noopToolCalls: []
      } as any,
      options: { requestId: 'req-falsy-error' } as any,
      contextBase: { base: {}, toolCalls: [], adapterContext: {}, requestId: 'req-falsy-error', entryEndpoint: 'openai', providerProtocol: 'openai-chat' } as any,
      baseForExecution: {} as any
    });

    expect(planServertoolExecutionLoopRuntimeActionWithNative).toHaveBeenNthCalledWith(2, {
      hasHandlerEntry: true,
      triggerMode: 'tool_call',
      hasMaterializedResult: false,
      hasHandlerError: true
    });
    expect(planServertoolExecutionLoopEffectWithNative).toHaveBeenCalledWith({
      mode: 'handler_error',
      toolCall: {
        id: 'call-falsy-error',
        name: 'web_search',
        arguments: '{}',
        executionMode: 'guarded',
        stripAfterExecute: true
      },
      handlerErrorMessage: ''
    });
  });
});
