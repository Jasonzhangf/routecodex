import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function bindProviderProtocol(adapterContext: Record<string, unknown>, providerProtocol = 'openai-responses'): void {
  const center = MetadataCenter.attach(adapterContext);
  if (!center.readRuntimeControl().providerProtocol) {
    center.writeRuntimeControl(
      'providerProtocol',
      providerProtocol,
      {
        module: 'tests/servertool/execution-stage-shell.spec.ts',
        symbol: 'bindProviderProtocol',
        stage: 'test'
      }
    );
  }
}

const buildServertoolDispatchPlanInputWithNative = jest.fn((input: any) => input);
const planServertoolToolCallDispatchWithNative = jest.fn((input: any) => ({
  executableToolCalls: Array.isArray(input?.toolCalls) ? input.toolCalls : [],
  skippedToolCalls: [],
  noopToolCalls: []
}));
const resolveServertoolPreExecutionBranchDecisionWithNative = jest.fn();
const resolveServertoolPostExecutionBranchDecisionWithNative = jest.fn();
const buildServertoolCliProjectionRuntimeBranchWithNative = jest.fn();
const planServertoolBuiltinAutoHandlerEntriesWithNative = jest.fn(() => ({
  entries: [],
  error: null
}));
const runServertoolIoExecutionQueue = jest.fn();
const runServertoolAutoHookCaller = jest.fn(async () => ({
  requiredHookResult: null,
  optionalHookResult: null,
  hookEvents: []
}));
const runServertoolResponseStageAutoHookPass = jest.fn(async () => ({
  action: 'continue_without_result'
}));
const createServertoolProviderProtocolErrorFromPlan = jest.fn((plan: any) => {
  const message = plan?.message ?? 'mock provider protocol error';
  return new Error(message);
});
const materializeNativeToolCallExecutionOutcome = jest.fn();
const finalizeServertoolResponseStageWithNative = jest.fn();

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    buildServertoolDispatchPlanInputWithNative,
    buildServertoolCliProjectionRuntimeBranchWithNative,
    finalizeServertoolResponseStageWithNative,
    inspectStopGatewaySignalWithNative: jest.fn((input: any) => input),
    materializeNativeToolCallExecutionOutcomeWithNative: materializeNativeToolCallExecutionOutcome,
    normalizeStopMessageCompareContextWithNative: jest.fn((input: any) =>
      input && typeof input === 'object' ? input : null
    ),
    planServertoolBuiltinAutoHandlerEntriesWithNative,
    planServertoolToolCallDispatchWithNative,
    resolveServertoolPostExecutionBranchDecisionWithNative,
    resolveServertoolPreExecutionBranchDecisionWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js',
  () => ({
    runServertoolIoExecutionQueue
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js',
  () => ({
    runServertoolAutoHookCaller
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.js',
  () => ({
    runServertoolResponseStageAutoHookPass
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan
  })
);

const { runServertoolExecutionStage } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.js'
);

describe('execution-stage-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildServertoolDispatchPlanInputWithNative.mockImplementation((input: any) => input);
    planServertoolToolCallDispatchWithNative.mockImplementation((input: any) => ({
      executableToolCalls: Array.isArray(input?.toolCalls) ? input.toolCalls : [],
      skippedToolCalls: [],
      noopToolCalls: []
    }));
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReturnValue({
      projectClientExecCli: false,
      continueResponseStage: true
    });
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReturnValue({
      resolveExecutionOutcome: true,
      continueResponseStage: false
    });
    runServertoolIoExecutionQueue.mockResolvedValue({
      executedToolCalls: [{ toolCall: { id: 'call_1' } }]
    });
    materializeNativeToolCallExecutionOutcome.mockReturnValue({
      mode: 'tool_flow',
      finalChatResponse: { ok: true },
      execution: { flowId: 'flow_1' }
    });
    finalizeServertoolResponseStageWithNative.mockReturnValue({
      mode: 'passthrough',
      finalChatResponse: { ok: true }
    });
    buildServertoolCliProjectionRuntimeBranchWithNative.mockReturnValue({
      resultMode: 'tool_flow',
      chatResponse: { cli: true },
      execution: { flowId: 'servertool_cli_projection' },
      result: {
        mode: 'tool_flow',
        finalChatResponse: { cli: true },
        execution: { flowId: 'servertool_cli_projection' }
      }
    });
  });

  test('keeps execution-stage orchestration in a dedicated owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts',
        'utf8'
      )
    );

    expect(source).not.toContain("from './dispatch-preparation-shell.js'");
    expect(source).not.toContain('prepareServertoolDispatchStage');
    expect(source).toContain('readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter');
    expect(source).toContain('planServertoolToolCallDispatchWithNative');
    expect(source).toContain('buildServertoolDispatchPlanInputWithNative');
    expect(source).toContain('dispatchPlan = planServertoolToolCallDispatchWithNative(');
    expect(source).not.toContain("from '../conversion/runtime-metadata.js'");
    expect(source).not.toContain('readRuntimeMetadata(');
    expect(source).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(source).not.toContain('Servertool dispatch preparation requires metadata center runtime_control.providerProtocol');
    expect(source).not.toContain('args.options.adapterContext as Record<string, unknown>');
    expect(source).toContain('resolveServertoolPreExecutionBranchDecisionWithNative');
    expect(source).toContain('resolveServertoolPostExecutionBranchDecisionWithNative');
    expect(source).toContain('buildServertoolCliProjectionRuntimeBranchWithNative');
    expect(source).not.toContain('mode: branch.resultMode');
    expect(source).not.toContain('finalChatResponse: branch.chatResponse as JsonObject');
    expect(source).not.toContain('execution: branch.execution as {');
    expect(source).not.toContain('finalChatResponse: branch.chatResponse');
    expect(source).not.toContain('execution: branch.execution');
    expect(source).toContain('return branch.result');
    expect(source).toContain('const preExecutionBranchDecision = resolveServertoolPreExecutionBranchDecisionWithNative({');
    expect(source).toContain('const postExecutionBranchDecision = resolveServertoolPostExecutionBranchDecisionWithNative({');
    expect(source).not.toContain('switch (preExecutionBranchPlan.action)');
    expect(source).not.toContain('switch (postExecutionBranchPlan.action)');
    expect(source).not.toContain("preExecutionBranchDecision.action === 'client_exec_cli_projection'");
    expect(source).not.toContain("preExecutionBranchDecision.action !== 'continue_response_stage'");
    expect(source).not.toContain("postExecutionBranchDecision.action === 'resolve_execution_outcome'");
    expect(source).not.toContain("postExecutionBranchDecision.action !== 'continue_response_stage'");
    expect(source).toContain('preExecutionBranchDecision.projectClientExecCli');
    expect(source).toContain('preExecutionBranchDecision.continueResponseStage');
    expect(source).toContain('postExecutionBranchDecision.resolveExecutionOutcome');
    expect(source).toContain('postExecutionBranchDecision.continueResponseStage');
    expect(source).toContain('invalid pre-execution branch action');
    expect(source).toContain("[servertool] invalid post-execution branch action");
    expect(source).not.toContain('String(preExecutionBranchPlan.action)');
    expect(source).not.toContain('String(postExecutionBranchPlan.action)');
    expect(source).not.toContain('contextBase: args.contextBase as ServerToolHandlerContext');
    expect(source).toContain('contextBase: args.contextBase');
    expect(source).toContain('runServertoolIoExecutionQueue');
    expect(source).toContain('materializeNativeToolCallExecutionOutcome');
    expect(source).toContain('materializeNativeToolCallExecutionOutcomeWithNative as materializeNativeToolCallExecutionOutcome');
    expect(source).not.toContain("from './execution-handler-materialization-shell.js'");
    expect(source).not.toContain("from './response-stage-finalize-shell.js'");
    expect(source).not.toContain('finalizeServertoolResponseStage(');
    expect(source).toContain('applyServertoolResponseStageFinalize');
    expect(source).toContain('runServertoolResponseStageAutoHookPass');
    expect(source).toContain('finalizeServertoolResponseStageWithNative');
    expect(source).toContain('responseStageAutoHookResult: responseStageAutoHook');
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

  test('builds dispatch plan directly from execution stage with MetadataCenter snapshot', async () => {
    const adapterContext: Record<string, unknown> = {};
    bindProviderProtocol(adapterContext, 'openai-responses');

    await runServertoolExecutionStage({
      options: {
        requestId: 'req-dispatch-native',
        entryEndpoint: '/v1/responses',
        adapterContext
      } as any,
      baseObject: { ok: true } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      contextBase: {} as any,
      includeToolCallNames: new Set([' Web_Search ', 'exec_command']),
      excludeToolCallNames: new Set([' Vision_Auto ']),
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      responseStageGatePlan: { responseHookMatched: false }
    });

    expect(buildServertoolDispatchPlanInputWithNative).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
        disableToolCallHandlers: false,
        includeToolCallHandlerNames: [' Web_Search ', 'exec_command'],
        excludeToolCallHandlerNames: [' Vision_Auto '],
        runtimeMetadata: expect.objectContaining({
          metadataCenterSnapshot: expect.objectContaining({
            runtimeControl: expect.objectContaining({
              providerProtocol: 'openai-responses'
            })
          })
        })
      })
    );
    expect(planServertoolToolCallDispatchWithNative).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }]
      })
    );
  });

  test('returns cli projection when pre-execution branch selects it', async () => {
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReturnValue({
      projectClientExecCli: true,
      continueResponseStage: false,
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

  test('fails fast when pre-execution branch returns an ambiguous native application plan', async () => {
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReturnValue({
      projectClientExecCli: false,
      continueResponseStage: false
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
    ).rejects.toThrow('[servertool] invalid pre-execution branch action');

    expect(runServertoolIoExecutionQueue).not.toHaveBeenCalled();
    expect(materializeNativeToolCallExecutionOutcome).not.toHaveBeenCalled();
    expect(runServertoolResponseStageAutoHookPass).not.toHaveBeenCalled();
    expect(finalizeServertoolResponseStageWithNative).not.toHaveBeenCalled();
  });

  test('projects executable tool calls directly into the native execution-branch planner', async () => {
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReturnValue({
      projectClientExecCli: false,
      continueResponseStage: true
    });
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReturnValue({
      resolveExecutionOutcome: true,
      continueResponseStage: false
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

    expect(resolveServertoolPreExecutionBranchDecisionWithNative).toHaveBeenCalledWith({
      executableToolCalls: [
        { id: 'call_1', name: 'web_search', arguments: '{}', executionMode: 'guarded' }
      ]
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
    expect(runServertoolResponseStageAutoHookPass).not.toHaveBeenCalled();
    expect(finalizeServertoolResponseStageWithNative).not.toHaveBeenCalled();
  });

  test('finalizes response stage only when post-execution branch explicitly continues', async () => {
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReturnValue({
      projectClientExecCli: false,
      continueResponseStage: true
    });
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReturnValue({
      resolveExecutionOutcome: false,
      continueResponseStage: true
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
    expect(runServertoolResponseStageAutoHookPass).toHaveBeenCalledWith({
      options: { requestId: 'req-continue' },
      baseObject: { ok: true },
      contextBase: {},
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      responseStageGatePlan: { responseHookMatched: false }
    });
    expect(finalizeServertoolResponseStageWithNative).toHaveBeenCalledWith({
      baseObject: { ok: true },
      responseStageGatePlan: { responseHookMatched: false },
      responseStageAutoHookResult: {
        action: 'continue_without_result'
      }
    });
  });

  test('returns auto-hook result when final auto-hook pass materializes one', async () => {
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReturnValue({
      projectClientExecCli: false,
      continueResponseStage: true
    });
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReturnValue({
      resolveExecutionOutcome: false,
      continueResponseStage: true
    });
    runServertoolIoExecutionQueue.mockResolvedValueOnce({
      executedToolCalls: []
    });
    runServertoolResponseStageAutoHookPass.mockResolvedValueOnce({
      action: 'return_auto_hook_result',
      result: {
        mode: 'tool_flow',
        finalChatResponse: { done: true },
        execution: { flowId: 'flow_1' }
      }
    });
    finalizeServertoolResponseStageWithNative.mockReturnValueOnce({
      mode: 'tool_flow',
      finalChatResponse: { done: true },
      execution: { flowId: 'flow_1' }
    });

    await expect(
      runServertoolExecutionStage({
        options: { requestId: 'req-auto-hook-result' } as any,
        baseObject: { ok: true } as any,
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
        contextBase: {} as any,
        includeToolCallNames: null,
        excludeToolCallNames: null,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookMatched: false, responseHookRequired: false }
      })
    ).resolves.toEqual({
      mode: 'tool_flow',
      finalChatResponse: { done: true },
      execution: { flowId: 'flow_1' }
    });

    expect(finalizeServertoolResponseStageWithNative).toHaveBeenCalledWith({
      baseObject: { ok: true },
      responseStageGatePlan: { responseHookMatched: false, responseHookRequired: false },
      responseStageAutoHookResult: {
        action: 'return_auto_hook_result',
        result: {
          mode: 'tool_flow',
          finalChatResponse: { done: true },
          execution: { flowId: 'flow_1' }
        }
      }
    });
  });

  test('fails fast when post-execution branch returns an ambiguous native application plan', async () => {
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPreExecutionBranchDecisionWithNative.mockReturnValue({
      projectClientExecCli: false,
      continueResponseStage: true
    });
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReset();
    resolveServertoolPostExecutionBranchDecisionWithNative.mockReturnValue({
      resolveExecutionOutcome: false,
      continueResponseStage: false
    });
    runServertoolIoExecutionQueue.mockResolvedValueOnce({
      executedToolCalls: []
    });

    await expect(
      runServertoolExecutionStage({
        options: { requestId: 'req-invalid-post' } as any,
        baseObject: { ok: true } as any,
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
        contextBase: {} as any,
        includeToolCallNames: null,
        excludeToolCallNames: null,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookMatched: false }
      })
    ).rejects.toThrow('[servertool] invalid post-execution branch action');

    expect(materializeNativeToolCallExecutionOutcome).not.toHaveBeenCalled();
    expect(runServertoolResponseStageAutoHookPass).not.toHaveBeenCalled();
    expect(finalizeServertoolResponseStageWithNative).not.toHaveBeenCalled();
  });
});
