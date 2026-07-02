import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolResponseStageGateWithNative = jest.fn();
const planServertoolResponseStageRuntimeActionWithNative = jest.fn();
const materializeServertoolResponseStageOrchestrationOutputWithNative = jest.fn();
const detectProviderResponseShapeWithNative = jest.fn(() => 'chat_completion');
const readRuntimeControlFromAnyBoundMetadataCenter = jest.fn(() => ({}));
const runServerToolOrchestrationShell = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolResponseStageGateWithNative,
    detectProviderResponseShapeWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    materializeServertoolResponseStageOrchestrationOutputWithNative,
    planServertoolResponseStageRuntimeActionWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js',
  () => ({
    readRuntimeControlFromAnyBoundMetadataCenter
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js',
  () => ({
    runServerToolOrchestrationShell
  })
);

const { runServertoolResponseStageOrchestrationShell } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.js'
);

describe('response-stage-orchestration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolResponseStageGateWithNative.mockReturnValue({
      nextAction: 'continue_to_execution',
      shouldBypass: false,
      responseHookMatched: false,
      responseHookRequired: false
    });
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'run_auto_hooks'
    });
    materializeServertoolResponseStageOrchestrationOutputWithNative.mockImplementation((input: any) =>
      input?.orchestrationExecuted === true
        ? {
            payload: input.executedPayload,
            executed: true,
            flowId: String(input.orchestrationFlowId ?? '').trim(),
            returnedExecutedPayload: true
          }
        : {
            payload: input.originalPayload,
            executed: false,
            returnedExecutedPayload: false
          }
    );
    runServerToolOrchestrationShell.mockResolvedValue({
      chat: { id: 'resp_1' },
      executed: false
    });
  });

  test('rejects bypass gate payload without skipReason at native parser boundary', async () => {
    const { parseServertoolResponseStageGatePayload } = await import(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.js'
    );

    expect(parseServertoolResponseStageGatePayload(JSON.stringify({
      nextAction: 'bypass',
      shouldBypass: true,
      responseHookMatched: false,
      responseHookRequired: false
    }))).toBeNull();
  });

  test('keeps bypass skipReason validation out of the orchestration shell', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
      'utf8'
    );

    expect(source).not.toContain("throw new Error('[servertool] native response-stage gate bypass missing skipReason')");
    expect(source).not.toContain('typeof gatePlan.skipReason');
    expect(source).not.toContain('gatePlan.skipReason.trim()');
    expect(source).not.toContain('gatePlan.skipReason as string');
    expect(source).not.toContain('String(gateRuntimeAction.action)');
    expect(source).not.toContain('String(outputPlan.returnAction)');
    expect(source).not.toContain('switch (outputPlan.returnAction)');
    expect(source).not.toContain("gatePlan.nextAction === 'bypass'");
    expect(source).not.toContain("if (gateRuntimeAction.action === 'return_passthrough_bypass')");
    expect(source).not.toContain('if (orchestration.executed)');
    expect(source).not.toContain('chat: options.payload as JsonObject');
    expect(source).not.toContain('options.adapterContext as Record<string, unknown>');
    expect(source).toContain('chat: options.payload');
    expect(source).toContain('adapterContext: options.adapterContext');
    expect(source).toContain('switch (gateRuntimeAction.action)');
    expect(source).toContain("case 'return_passthrough_bypass'");
    expect(source).toContain("case 'run_auto_hooks'");
    expect(source).toContain('invalid response-stage orchestration action');
    expect(source).toContain('planServertoolResponseStageRuntimeActionWithNative({');
    expect(source).toContain('materializeServertoolResponseStageOrchestrationOutputWithNative({');
  });

  test('returns native skipReason without TS fallback or whitelist filtering', async () => {
    const stageRecorder = { record: jest.fn() };
    planServertoolResponseStageGateWithNative.mockReturnValue({
      nextAction: 'bypass',
      shouldBypass: true,
      responseHookMatched: false,
      responseHookRequired: false,
      skipReason: 'empty_assistant_payload'
    });
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'return_passthrough_bypass',
      resultMode: 'passthrough',
      skipReason: 'empty_assistant_payload'
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_2' },
        adapterContext: {} as any,
        requestId: 'req-native-skip',
        entryEndpoint: '/v1/responses',
        stageRecorder: stageRecorder as any
      })
    ).resolves.toEqual({
      payload: { id: 'resp_2' },
      executed: false,
      skipReason: 'empty_assistant_payload'
    });
    expect(stageRecorder.record).toHaveBeenCalledWith(
      'HubRespChatProcess03Governed.servertool_orchestration',
      expect.objectContaining({
        executed: false,
        skipReason: 'empty_assistant_payload',
        inputShape: 'chat_completion'
      })
    );
    expect(runServerToolOrchestrationShell).not.toHaveBeenCalled();
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenCalledWith({
      responseStageGatePlan: {
        nextAction: 'bypass',
        shouldBypass: true,
        responseHookMatched: false,
        responseHookRequired: false,
        skipReason: 'empty_assistant_payload'
      },
      autoHookEvaluated: false,
      hasAutoHookResult: false
    });
  });

  test('uses native orchestration output materializer for executed response projection', async () => {
    const stageRecorder = { record: jest.fn() };
    runServerToolOrchestrationShell.mockResolvedValue({
      chat: { id: 'resp_executed' },
      executed: true,
      flowId: ' flow_executed '
    });
    materializeServertoolResponseStageOrchestrationOutputWithNative.mockReturnValue({
      payload: { id: 'resp_executed' },
      executed: true,
      flowId: 'flow_executed',
      returnedExecutedPayload: true
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_input' },
        adapterContext: {} as any,
        requestId: 'req-output-plan',
        entryEndpoint: '/v1/chat/completions',
        stageRecorder: stageRecorder as any
      })
    ).resolves.toEqual({
      payload: { id: 'resp_executed' },
      executed: true,
      flowId: 'flow_executed'
    });

    expect(materializeServertoolResponseStageOrchestrationOutputWithNative).toHaveBeenCalledWith({
      originalPayload: { id: 'resp_input' },
      executedPayload: { id: 'resp_executed' },
      orchestrationExecuted: true,
      orchestrationFlowId: ' flow_executed '
    });
    expect(stageRecorder.record).toHaveBeenCalledWith(
      'HubRespChatProcess03Governed.servertool_orchestration',
      expect.objectContaining({
        executed: true,
        flowId: 'flow_executed',
        inputShape: 'chat_completion',
        outputShape: 'chat_completion'
      })
    );
  });

  test('fails fast for unknown response-stage runtime action', async () => {
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'unknown_response_stage_action'
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_unknown_runtime_action' },
        adapterContext: {} as any,
        requestId: 'req-unknown-response-stage-action',
        entryEndpoint: '/v1/responses'
      })
    ).rejects.toThrow('[servertool] invalid response-stage orchestration action');
    expect(runServerToolOrchestrationShell).not.toHaveBeenCalled();
  });

  test('uses native orchestration output materializer for original response projection', async () => {
    const stageRecorder = { record: jest.fn() };
    runServerToolOrchestrationShell.mockResolvedValue({
      chat: { id: 'resp_ignored' },
      executed: false
    });
    materializeServertoolResponseStageOrchestrationOutputWithNative.mockReturnValue({
      payload: { id: 'resp_original' },
      executed: false,
      returnedExecutedPayload: false
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_original' },
        adapterContext: {} as any,
        requestId: 'req-output-original',
        entryEndpoint: '/v1/responses',
        stageRecorder: stageRecorder as any
      })
    ).resolves.toEqual({
      payload: { id: 'resp_original' },
      executed: false
    });

    expect(materializeServertoolResponseStageOrchestrationOutputWithNative).toHaveBeenCalledWith({
      originalPayload: { id: 'resp_original' },
      executedPayload: { id: 'resp_ignored' },
      orchestrationExecuted: false,
      orchestrationFlowId: undefined
    });
    expect(stageRecorder.record).toHaveBeenCalledWith(
      'HubRespChatProcess03Governed.servertool_orchestration',
      expect.objectContaining({
        executed: false,
        inputShape: 'chat_completion'
      })
    );
  });
});
