import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runServertoolResponseStageAutoHookPass = jest.fn();
const planServertoolResponseStageRuntimeActionWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.js',
  () => ({
    runServertoolResponseStageAutoHookPass
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolResponseStageRuntimeActionWithNative
  })
);

const { finalizeServertoolResponseStage } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-finalize-shell.js'
);

describe('response-stage-finalize-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'continue_without_result'
    });
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'return_passthrough_no_auto_hook_result',
      resultMode: 'passthrough'
    });
  });

  test('consumes the prepass gate truth directly', async () => {
    const responseStageGatePlan = {
      responseHookMatched: true,
      responseHookRequired: false
    };

    const result = await finalizeServertoolResponseStage({
      options: { adapterContext: {}, requestId: 'req-1' } as any,
      baseObject: { ok: true },
      contextBase: {} as any,
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      responseStageGatePlan
    });

    expect(runServertoolResponseStageAutoHookPass).toHaveBeenCalledWith(
      expect.objectContaining({
        responseStageGatePlan
      })
    );
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenCalledWith({
      responseStageGatePlan,
      autoHookEvaluated: true,
      hasAutoHookResult: false
    });
    expect(result).toEqual({
      mode: 'passthrough',
      finalChatResponse: { ok: true }
    });
  });

  test('returns bypass passthrough from the provided gate plan', async () => {
    const responseStageGatePlan = {
      responseHookMatched: false,
      responseHookRequired: false
    };
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'return_passthrough_bypass'
    });
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'return_passthrough_bypass',
      resultMode: 'passthrough'
    });

    const result = await finalizeServertoolResponseStage({
      options: { adapterContext: { req: true }, requestId: 'req-2' } as any,
      baseObject: { ok: true },
      contextBase: {} as any,
      includeAutoHookIds: null,
      excludeAutoHookIds: null,
      responseStageGatePlan
    });

    expect(runServertoolResponseStageAutoHookPass).toHaveBeenCalledWith(
      expect.objectContaining({
        responseStageGatePlan
      })
    );
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenCalledWith({
      responseStageGatePlan,
      autoHookEvaluated: true,
      hasAutoHookResult: false
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
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'return_auto_hook_result'
    });

    await expect(
      finalizeServertoolResponseStage({
        options: { adapterContext: {}, requestId: 'req-3' } as any,
        baseObject: { ok: true },
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null
        ,
        responseStageGatePlan: { responseHookMatched: false, responseHookRequired: false }
      })
    ).resolves.toEqual({
      mode: 'tool_flow',
      finalChatResponse: { done: true },
      execution: { flowId: 'flow_1' }
    });
  });

  test('keeps response-stage gate replanning out of finalize shell', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/response-stage-finalize-shell.ts',
      'utf8'
    );

    expect(source).toContain('responseStageGatePlan: args.responseStageGatePlan');
    expect(source).toContain('NativeServertoolResponseStageGate');
    expect(source).not.toContain('responseStageGatePlan: Record<string, unknown>');
    expect(source).toContain("contextBase: Omit<ServerToolHandlerContext, 'toolCall'>");
    expect(source).not.toContain('initialResponseStageGatePlan');
    expect(source).not.toContain('planServertoolResponseStageGateWithNative');
    expect(source).not.toContain('readRuntimeControlFromAnyBoundMetadataCenter');
    expect(source).not.toContain('responseHookMatched === true');
    expect(source).not.toContain("responseStageAutoHook.action === 'return_passthrough_bypass'");
    expect(source).not.toContain("if (finalizeRuntimeAction.action === 'return_auto_hook_result')");
    expect(source).not.toContain('autoHookResult == null');
    expect(source).not.toContain('autoHookResult as ServerSideToolEngineResult');
    expect(source).not.toContain('native response-stage finalize requested auto-hook result but result was empty');
    expect(source).toContain('switch (finalizeRuntimeAction.action)');
    expect(source).toContain("hasAutoHookResult: responseStageAutoHook.action === 'return_auto_hook_result'");
    expect(source).toContain('return responseStageAutoHook.result');
    expect(source).toContain('mode: finalizeRuntimeAction.resultMode');
    expect(source).not.toContain("return { mode: 'passthrough', finalChatResponse: args.baseObject };");
    expect(source).toContain('planServertoolResponseStageRuntimeActionWithNative({');
  });

  test('fails fast for unknown finalize native runtime action', async () => {
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'unknown_finalize_action'
    });

    await expect(
      finalizeServertoolResponseStage({
        options: { adapterContext: {}, requestId: 'req-unknown-finalize' } as any,
        baseObject: { ok: true },
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: {
          shouldBypass: false,
          nextAction: 'continue_to_execution',
          responseHookMatched: false,
          responseHookRequired: false
        }
      })
    ).rejects.toThrow('[servertool] invalid response-stage finalize action');
  });
});
