import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolResponseStageGateWithNative = jest.fn();
const planServertoolResponseStageRuntimeActionWithNative = jest.fn();
const runServertoolResponseStageAutoHookPass = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolResponseStageGateWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolResponseStageRuntimeActionWithNative,
    inspectStopGatewaySignalWithNative: jest.fn(() => ({ reason: 'test' })),
    normalizeStopMessageCompareContextWithNative: jest.fn(() => ({ source: 'test' }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.js',
  () => ({
    runServertoolResponseStageAutoHookPass
  })
);

const { runServertoolResponseStagePrePass } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-prepass-shell.js'
);

describe('response-stage-prepass-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: false,
      responseHookRequired: false,
      nextAction: 'continue_to_execution'
    });
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'return_passthrough_no_auto_hook_result'
    });
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'continue_without_result'
    });
  });

  test('plans response-stage gate and skips auto-hook when no response hook matched', async () => {
    await expect(
      runServertoolResponseStagePrePass({
        options: { adapterContext: { trace: true }, requestId: 'req-1' } as any,
        baseObject: { ok: true },
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).resolves.toEqual({
      action: 'continue_to_execution',
      responseStageGatePlan: {
        responseHookMatched: false,
        responseHookRequired: false,
        nextAction: 'continue_to_execution'
      }
    });
    expect(planServertoolResponseStageGateWithNative).toHaveBeenCalledWith({
      payload: { ok: true },
      adapterContext: { trace: true }
    });
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenCalledWith({
      responseStageGatePlan: {
        responseHookMatched: false,
        responseHookRequired: false,
        nextAction: 'continue_to_execution'
      },
      autoHookEvaluated: false,
      hasAutoHookResult: false
    });
    expect(runServertoolResponseStageAutoHookPass).not.toHaveBeenCalled();
  });

  test('returns early auto-hook result when matched response hook materializes one', async () => {
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: true,
      responseHookRequired: false,
      nextAction: 'run_auto_hooks'
    });
    planServertoolResponseStageRuntimeActionWithNative
      .mockReturnValueOnce({
        action: 'run_auto_hooks'
      });
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'return_auto_hook_result',
      result: {
        mode: 'tool_flow',
        finalChatResponse: { done: true },
        execution: { flowId: 'flow_1' }
      }
    });

    await expect(
      runServertoolResponseStagePrePass({
        options: { adapterContext: {}, requestId: 'req-2' } as any,
        baseObject: { ok: true },
        contextBase: { base: { ok: true }, toolCalls: [] } as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).resolves.toEqual({
      action: 'return_result',
      responseStageGatePlan: {
        responseHookMatched: true,
        responseHookRequired: false,
        nextAction: 'run_auto_hooks'
      },
      result: {
        mode: 'tool_flow',
        finalChatResponse: { done: true },
        execution: { flowId: 'flow_1' }
      }
    });
    expect(runServertoolResponseStageAutoHookPass).toHaveBeenCalledWith(
      expect.objectContaining({
        responseStageGatePlan: {
          responseHookMatched: true,
          responseHookRequired: false,
          nextAction: 'run_auto_hooks'
        }
      })
    );
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenCalledTimes(1);
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenLastCalledWith({
      responseStageGatePlan: {
        responseHookMatched: true,
        responseHookRequired: false,
        nextAction: 'run_auto_hooks'
      },
      autoHookEvaluated: false,
      hasAutoHookResult: false
    });
  });

  test('keeps post-auto-hook passthrough decision in Rust runtime action plan', async () => {
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: true,
      responseHookRequired: false,
      nextAction: 'run_auto_hooks'
    });
    planServertoolResponseStageRuntimeActionWithNative
      .mockReturnValueOnce({
        action: 'run_auto_hooks'
      });
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'continue_without_result'
    });

    await expect(
      runServertoolResponseStagePrePass({
        options: { adapterContext: {}, requestId: 'req-post-auto-hook-passthrough' } as any,
        baseObject: { ok: true },
        contextBase: { base: { ok: true }, toolCalls: [] } as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).resolves.toEqual({
      action: 'continue_to_execution',
      responseStageGatePlan: {
        responseHookMatched: true,
        responseHookRequired: false,
        nextAction: 'run_auto_hooks'
      }
    });
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenCalledTimes(1);
    expect(planServertoolResponseStageRuntimeActionWithNative).toHaveBeenLastCalledWith({
      responseStageGatePlan: {
        responseHookMatched: true,
        responseHookRequired: false,
        nextAction: 'run_auto_hooks'
      },
      autoHookEvaluated: false,
      hasAutoHookResult: false
    });
  });

  test('keeps prepass auto-hook decision in Rust runtime action plan', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/response-stage-prepass-shell.ts',
      'utf8'
    );

    expect(source).toContain('planServertoolResponseStageRuntimeActionWithNative({');
    expect(source).not.toContain("prepassRuntimeAction.action !== 'run_auto_hooks'");
    expect(source).toContain('switch (prepassRuntimeAction.action)');
    expect(source).toContain('switch (responseStageAutoHook.action)');
    expect(source).not.toContain('autoHookResult as ServerSideToolEngineResult');
    expect(source).not.toContain('responseStageGatePlan.responseHookMatched !== true');
    expect(source).not.toContain('responseHookMatched !== true');
  });

  test('fails fast for unknown prepass native runtime action', async () => {
    planServertoolResponseStageRuntimeActionWithNative.mockReset();
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValueOnce({
      action: 'unknown_prepass_action'
    });

    await expect(
      runServertoolResponseStagePrePass({
        options: { adapterContext: {}, requestId: 'req-unknown-prepass' } as any,
        baseObject: { ok: true },
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).rejects.toThrow('[servertool] invalid response-stage prepass action: unknown_prepass_action');
    expect(runServertoolResponseStageAutoHookPass).not.toHaveBeenCalled();
  });
});
