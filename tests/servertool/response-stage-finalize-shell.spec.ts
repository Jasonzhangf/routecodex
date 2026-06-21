import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolResponseStageGateWithNative = jest.fn();
const runServertoolResponseStageAutoHookPass = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolResponseStageGateWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.js',
  () => ({
    runServertoolResponseStageAutoHookPass
  })
);

const { finalizeServertoolResponseStage } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-finalize-shell.js'
);

describe('response-stage-finalize-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: false,
      responseHookRequired: false
    });
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'continue_without_result'
    });
  });

  test('reuses initial matched gate plan instead of re-planning in impl', async () => {
    const initialPlan = {
      responseHookMatched: true,
      responseHookRequired: false
    };

    const result = await finalizeServertoolResponseStage({
      options: { adapterContext: {}, requestId: 'req-1' } as any,
      baseObject: { ok: true },
      contextBase: {} as any,
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      initialResponseStageGatePlan: initialPlan
    });

    expect(planServertoolResponseStageGateWithNative).not.toHaveBeenCalled();
    expect(runServertoolResponseStageAutoHookPass).toHaveBeenCalledWith(
      expect.objectContaining({
        responseStageGatePlan: initialPlan
      })
    );
    expect(result).toEqual({
      mode: 'passthrough',
      finalChatResponse: { ok: true }
    });
  });

  test('plans gate when initial plan is not matched and returns bypass passthrough', async () => {
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: false,
      responseHookRequired: false
    });
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'return_passthrough_bypass'
    });

    const result = await finalizeServertoolResponseStage({
      options: { adapterContext: { req: true }, requestId: 'req-2' } as any,
      baseObject: { ok: true },
      contextBase: {} as any,
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      initialResponseStageGatePlan: { responseHookMatched: false }
    });

    expect(planServertoolResponseStageGateWithNative).toHaveBeenCalledWith({
      payload: { ok: true },
      adapterContext: { req: true }
    });
    expect(result).toEqual({
      mode: 'passthrough',
      finalChatResponse: { ok: true }
    });
  });

  test('returns auto-hook result when final auto-hook pass materializes one', async () => {
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'return_auto_hook_result',
      result: {
        mode: 'tool_flow',
        finalChatResponse: { done: true },
        execution: { flowId: 'flow_1' }
      }
    });

    await expect(
      finalizeServertoolResponseStage({
        options: { adapterContext: {}, requestId: 'req-3' } as any,
        baseObject: { ok: true },
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).resolves.toEqual({
      mode: 'tool_flow',
      finalChatResponse: { done: true },
      execution: { flowId: 'flow_1' }
    });
  });
});
