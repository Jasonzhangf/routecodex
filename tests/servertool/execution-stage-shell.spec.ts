import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const prepareServertoolDispatchStage = jest.fn();
const planServertoolExecutionBranchWithNative = jest.fn();
const buildServertoolCliProjectionRuntimeBranchWithNative = jest.fn();
const runServertoolIoExecutionQueue = jest.fn();
const materializeNativeToolCallExecutionOutcome = jest.fn();
const finalizeServertoolResponseStage = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.js',
  () => ({
    prepareServertoolDispatchStage
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    buildServertoolCliProjectionRuntimeBranchWithNative,
    planServertoolExecutionBranchWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js',
  () => ({
    runServertoolIoExecutionQueue
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
    materializeNativeToolCallExecutionOutcome
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-finalize-shell.js',
  () => ({
    finalizeServertoolResponseStage
  })
);

const { runServertoolExecutionStage } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.js'
);

describe('execution-stage-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prepareServertoolDispatchStage.mockReturnValue({
      dispatchPlan: {
        executableToolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}', executionMode: 'guarded' }]
      }
    });
    planServertoolExecutionBranchWithNative
      .mockReturnValueOnce({ action: 'continue_response_stage' })
      .mockReturnValueOnce({ action: 'resolve_execution_outcome' });
    runServertoolIoExecutionQueue.mockResolvedValue({
      executedToolCalls: [{ toolCall: { id: 'call_1' } }]
    });
    materializeNativeToolCallExecutionOutcome.mockReturnValue({
      mode: 'tool_flow',
      finalChatResponse: { ok: true },
      execution: { flowId: 'flow_1' }
    });
    finalizeServertoolResponseStage.mockResolvedValue({
      mode: 'passthrough',
      finalChatResponse: { ok: true }
    });
    buildServertoolCliProjectionRuntimeBranchWithNative.mockReturnValue({
      resultMode: 'tool_flow',
      chatResponse: { cli: true },
      execution: { flowId: 'servertool_cli_projection' }
    });
  });

  test('keeps execution-stage orchestration in a dedicated owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('prepareServertoolDispatchStage');
    expect(source).toContain('planServertoolExecutionBranchWithNative');
    expect(source).toContain('buildServertoolCliProjectionRuntimeBranchWithNative');
    expect(source).toContain('mode: branch.resultMode');
    expect(source).toContain('const preExecutionBranchPlan = planServertoolExecutionBranchWithNative({');
    expect(source).toContain('const postExecutionBranchPlan = planServertoolExecutionBranchWithNative({');
    expect(source).toContain('switch (preExecutionBranchPlan.action)');
    expect(source).toContain("case 'continue_response_stage':");
    expect(source).toContain('invalid pre-execution branch action');
    expect(source).toContain("case 'continue_response_stage':");
    expect(source).toContain("throw new Error(`[servertool] invalid post-execution branch action:");
    expect(source).toContain('runServertoolIoExecutionQueue');
    expect(source).toContain('materializeNativeToolCallExecutionOutcome');
    expect(source).toContain('finalizeServertoolResponseStage');
    expect(source).not.toContain("from './cli-projection-runtime-shell.js'");
    expect(source).not.toContain('buildServertoolCliProjectionBranchResult');
    expect(source).not.toContain('function planExecutionBranchRuntimeAction(');
    expect(source).not.toContain('const preExecutionBranchInput = {');
    expect(source).not.toContain('const postExecutionBranchInput = {');
    expect(source).not.toContain('filterOutExecutedToolCalls');
    expect(source).not.toContain('stripToolOutputs');
    expect(source).not.toContain('structuredClone(args.baseObject)');
    expect(source).not.toContain("mode: 'tool_flow'");
    expect(source).not.toContain('const baseForExecution = args.baseObject;');
    expect(source).not.toContain('isStopMessageAutoPreProjection');
  });

  test('returns cli projection when pre-execution branch selects it', async () => {
    planServertoolExecutionBranchWithNative.mockReset();
    planServertoolExecutionBranchWithNative.mockReturnValue({
      action: 'client_exec_cli_projection',
      projectedToolCall: {
        id: 'call_1',
        name: 'web_search',
        arguments: '{}'
      }
    });

    await expect(
      runServertoolExecutionStage({
        options: { requestId: 'req-1' } as any,
        baseObject: { ok: true } as any,
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
        contextBase: {} as any,
        includeToolCallNames: null,
        excludeToolCallNames: null,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookMatched: false }
      })
    ).resolves.toEqual({
      mode: 'tool_flow',
      finalChatResponse: { cli: true },
      execution: { flowId: 'servertool_cli_projection' }
    });
    expect(runServertoolIoExecutionQueue).not.toHaveBeenCalled();
    expect(buildServertoolCliProjectionRuntimeBranchWithNative).toHaveBeenCalledWith({
      requestId: 'req-1',
      toolName: 'web_search',
      toolArguments: '{}',
      projectedToolCallId: 'call_1',
      base: { ok: true }
    });
  });

  test('fails fast when pre-execution branch returns an unknown native action', async () => {
    planServertoolExecutionBranchWithNative.mockReset();
    planServertoolExecutionBranchWithNative.mockReturnValue({
      action: 'unknown_native_action'
    });

    await expect(
      runServertoolExecutionStage({
        options: { requestId: 'req-invalid-pre' } as any,
        baseObject: { ok: true } as any,
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
        contextBase: {} as any,
        includeToolCallNames: null,
        excludeToolCallNames: null,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookMatched: false }
      })
    ).rejects.toThrow('[servertool] invalid pre-execution branch action: unknown_native_action');

    expect(runServertoolIoExecutionQueue).not.toHaveBeenCalled();
    expect(materializeNativeToolCallExecutionOutcome).not.toHaveBeenCalled();
    expect(finalizeServertoolResponseStage).not.toHaveBeenCalled();
  });

  test('projects executable tool calls directly into the native execution-branch planner', async () => {
    planServertoolExecutionBranchWithNative.mockReset();
    planServertoolExecutionBranchWithNative
      .mockReturnValueOnce({
        action: 'continue_response_stage'
      })
      .mockReturnValueOnce({
        action: 'resolve_execution_outcome'
      });

    await runServertoolExecutionStage({
      options: { requestId: 'req-branch-inline' } as any,
      baseObject: { ok: true } as any,
      toolCalls: [
        { id: 'call_1', name: 'web_search', arguments: '{}', executionMode: 'guarded' }
      ],
      contextBase: {} as any,
      includeToolCallNames: null,
      excludeToolCallNames: null,
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      responseStageGatePlan: { responseHookMatched: false }
    });

    expect(planServertoolExecutionBranchWithNative).toHaveBeenCalledWith({
      executableToolCalls: [
        { id: 'call_1', name: 'web_search', arguments: '{}', executionMode: 'guarded' }
      ],
      executedToolCallsLen: 0
    });
  });

  test('materializes execution outcome when post-execution branch selects it', async () => {
    await expect(
      runServertoolExecutionStage({
        options: { requestId: 'req-2' } as any,
        baseObject: { ok: true } as any,
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
        contextBase: {} as any,
        includeToolCallNames: null,
        excludeToolCallNames: null,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookMatched: false }
      })
    ).resolves.toEqual({
      mode: 'tool_flow',
      finalChatResponse: { ok: true },
      execution: { flowId: 'flow_1' }
    });
    expect(materializeNativeToolCallExecutionOutcome).toHaveBeenCalled();
    expect(materializeNativeToolCallExecutionOutcome).toHaveBeenCalledWith({
      baseForExecution: { ok: true },
      options: { requestId: 'req-2' },
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      executionState: {
        executedToolCalls: [{ toolCall: { id: 'call_1' } }]
      }
    });
    expect(finalizeServertoolResponseStage).not.toHaveBeenCalled();
  });

  test('finalizes response stage only when post-execution branch explicitly continues', async () => {
    planServertoolExecutionBranchWithNative.mockReset();
    planServertoolExecutionBranchWithNative
      .mockReturnValueOnce({
        action: 'continue_response_stage'
      })
      .mockReturnValueOnce({
        action: 'continue_response_stage'
      });
    runServertoolIoExecutionQueue.mockResolvedValueOnce({
      executedToolCalls: []
    });

    await expect(
      runServertoolExecutionStage({
        options: { requestId: 'req-continue' } as any,
        baseObject: { ok: true } as any,
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
        contextBase: {} as any,
        includeToolCallNames: null,
        excludeToolCallNames: null,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookMatched: false }
      })
    ).resolves.toEqual({
      mode: 'passthrough',
      finalChatResponse: { ok: true }
    });

    expect(materializeNativeToolCallExecutionOutcome).not.toHaveBeenCalled();
    expect(finalizeServertoolResponseStage).toHaveBeenCalledWith({
      options: { requestId: 'req-continue' },
      baseObject: { ok: true },
      contextBase: {},
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      responseStageGatePlan: { responseHookMatched: false }
    });
  });
});
