import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolResponseStageGateWithNative = jest.fn();
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
    runServerToolOrchestrationShell.mockResolvedValue({
      chat: { id: 'resp_1' },
      executed: false
    });
  });

  test('fails fast when native bypass plan omits skipReason', async () => {
    planServertoolResponseStageGateWithNative.mockReturnValue({
      nextAction: 'bypass',
      shouldBypass: true,
      responseHookMatched: false,
      responseHookRequired: false
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_1' },
        adapterContext: {} as any,
        requestId: 'req-missing-skip',
        entryEndpoint: '/v1/responses'
      })
    ).rejects.toThrow('[servertool] native response-stage gate bypass missing skipReason');
    expect(runServerToolOrchestrationShell).not.toHaveBeenCalled();
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
  });
});
