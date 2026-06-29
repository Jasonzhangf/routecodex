import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getServerToolHandler = jest.fn();
const runServertoolHandler = jest.fn();
const materializeServertoolPlannedResult = jest.fn();
const createServertoolExecutionLoopStateFromNative = jest.fn();
const appendExecutedToolRecordFromNative = jest.fn();
const buildServertoolHandlerErrorToolOutputPayloadWithNative = jest.fn();
const planServertoolExecutionDispatchErrorWithNative = jest.fn();
const planServertoolExecutionLoopEffectWithNative = jest.fn();
const planServertoolExecutionLoopRuntimeActionWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js',
  () => ({
    getServerToolHandler,
    listAdHocRegisteredToolCallHandlerSpecs: jest.fn(() => [])
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
    materializeServertoolPlannedResult,
    executeBuiltinServerToolHandler: jest.fn(),
    runServertoolHandler,
    createServertoolExecutionLoopStateFromNative,
    appendExecutedToolRecordFromNative
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
    planServertoolExecutionLoopRuntimeActionWithNative
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
      }
    }));
    materializeServertoolPlannedResult.mockResolvedValue({
      chatResponse: { ok: true },
      execution: { flowId: 'flow-1' }
    });
    runServertoolHandler.mockResolvedValue({
      finalize: jest.fn(),
      flowId: 'flow-1'
    });
    getServerToolHandler.mockReturnValue({
      trigger: 'tool_call',
      registration: { executionMode: 'guarded' },
      execution: {
        kind: 'adhoc',
        handler: jest.fn()
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
    expect(source).toContain('createServertoolProviderProtocolErrorFromPlan');
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
    expect(materializeServertoolPlannedResult).toHaveBeenCalled();
    expect(appendExecutedToolRecordFromNative).toHaveBeenCalled();
  });
});
