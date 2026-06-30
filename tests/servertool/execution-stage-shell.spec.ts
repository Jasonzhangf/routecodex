import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const prepareServertoolDispatchStage = jest.fn();
const planServertoolExecutionBranchRuntimeAction = jest.fn();
const buildServertoolCliProjectionBranchResult = jest.fn();
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
  '../../sharedmodule/llmswitch-core/src/servertool/execution-branch-runtime-shell.js',
  () => ({
    planServertoolExecutionBranchRuntimeAction
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.js',
  () => ({
    buildServertoolCliProjectionBranchResult
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
  '../../sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.js',
  () => ({
    filterOutExecutedToolCalls: jest.fn(),
    stripToolOutputs: jest.fn()
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
        executableToolCalls: [{ id: 'call_1', name: 'web_search', executionMode: 'guarded' }]
      }
    });
    planServertoolExecutionBranchRuntimeAction
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
    buildServertoolCliProjectionBranchResult.mockReturnValue({
      mode: 'tool_flow',
      finalChatResponse: { cli: true },
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
    expect(source).toContain('planServertoolExecutionBranchRuntimeAction');
    expect(source).toContain('runServertoolIoExecutionQueue');
    expect(source).toContain('materializeNativeToolCallExecutionOutcome');
    expect(source).toContain('finalizeServertoolResponseStage');
    expect(source).not.toContain('structuredClone(args.baseObject)');
    expect(source).not.toContain('isStopMessageAutoPreProjection');
  });

  test('returns cli projection when pre-execution branch selects it', async () => {
    planServertoolExecutionBranchRuntimeAction.mockReset();
    planServertoolExecutionBranchRuntimeAction.mockReturnValue({
      action: 'client_exec_cli_projection',
      projectedToolCallIndex: 0
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
    expect(finalizeServertoolResponseStage).not.toHaveBeenCalled();
  });
});
