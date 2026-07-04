import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolResponseStageRuntimeActionWithNative = jest.fn();
const planServertoolRequiredResponseHookEmptyErrorWithNative = jest.fn();
const resolveServertoolResponseStageAutoHookPreDecisionWithNative = jest.fn((input: any) => {
  const action = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: input.responseStageGatePlan,
    baseObject: input.baseObject,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  }) as any;
  if (action.action === 'return_passthrough_bypass') {
    return {
      action: 'return_pass_result',
      result: action.passResult
    };
  }
  if (action.action === 'run_auto_hooks') {
    return { action: 'run_auto_hooks' };
  }
  throw new Error('[servertool] invalid response-stage pre auto-hook action');
});
const resolveServertoolResponseStageAutoHookPostDecisionWithNative = jest.fn((input: any) => {
  const action = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: input.responseStageGatePlan,
    baseObject: input.baseObject,
    autoHookEvaluated: true,
    hasAutoHookResult: input.autoHookResult != null,
    autoHookResult: input.autoHookResult
  }) as any;
  if (action.action === 'return_required_response_hook_empty') {
    return {
      action: 'throw_required_response_hook_empty',
      errorPlan: planServertoolRequiredResponseHookEmptyErrorWithNative({
        requestId: input.requestId,
        responseHookName: action.responseHookName
      })
    };
  }
  if (
    action.action === 'return_auto_hook_result' ||
    action.action === 'return_passthrough_no_auto_hook_result'
  ) {
    return {
      action: 'return_pass_result',
      result: action.passResult
    };
  }
  throw new Error('[servertool] invalid response-stage post auto-hook action');
});
const runServertoolAutoHookCaller = jest.fn();
const createServertoolProviderProtocolErrorFromPlan = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolResponseStageRuntimeActionWithNative,
    planServertoolRequiredResponseHookEmptyErrorWithNative,
    resolveServertoolResponseStageAutoHookPreDecisionWithNative,
    resolveServertoolResponseStageAutoHookPostDecisionWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js',
  () => ({
    runServertoolAutoHookCaller
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan
  })
);

const { runServertoolResponseStageAutoHookPass } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.js'
);

describe('response-stage-auto-hook-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolResponseStageRuntimeActionWithNative.mockImplementation((input: any) => {
      if (input?.autoHookEvaluated === false) {
        return input?.responseStageGatePlan?.nextAction === 'bypass'
          ? { action: 'return_passthrough_bypass', passResult: { action: 'return_passthrough_bypass' } }
          : { action: 'run_auto_hooks' };
      }
      if (input?.hasAutoHookResult === true) {
        return {
          action: 'return_auto_hook_result',
          passResult: {
            action: 'return_auto_hook_result',
            result: input?.autoHookResult
          }
        };
      }
      if (input?.responseStageGatePlan?.responseHookRequired === true) {
        return {
          action: 'return_required_response_hook_empty',
          responseHookName: String(input?.responseStageGatePlan?.responseHookName ?? '').trim()
        };
      }
      return { action: 'return_passthrough_no_auto_hook_result', passResult: { action: 'continue_without_result' } };
    });
    runServertoolAutoHookCaller.mockResolvedValue({
      mode: 'tool_flow',
      finalChatResponse: { ok: true },
      execution: { flowId: 'flow_1' }
    });
    planServertoolRequiredResponseHookEmptyErrorWithNative.mockImplementation((input: any) => ({
      message: `required hook empty: ${String(input?.responseHookName ?? 'unknown')}`,
      code: 'SERVERTOOL_REQUIRED_RESPONSE_HOOK_EMPTY',
      category: 'upstream_protocol_error',
      status: 502,
      details: input
    }));
    createServertoolProviderProtocolErrorFromPlan.mockImplementation((plan: any) => {
      const err = new Error(String(plan?.message ?? 'servertool error'));
      (err as Error & { code?: string }).code = 'SERVERTOOL_REQUIRED_RESPONSE_HOOK_EMPTY';
      return err;
    });
  });

  test('bypasses when native runtime action says bypass', async () => {
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({
      action: 'return_passthrough_bypass',
      passResult: { action: 'return_passthrough_bypass' }
    });

    await expect(
      runServertoolResponseStageAutoHookPass({
        options: { requestId: 'req-1' } as any,
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookRequired: false },
        baseObject: { ok: true }
      })
    ).resolves.toEqual({ action: 'return_passthrough_bypass' });
    expect(runServertoolAutoHookCaller).not.toHaveBeenCalled();
  });

  test('returns auto-hook result when runtime action selects it', async () => {
    await expect(
      runServertoolResponseStageAutoHookPass({
        options: { requestId: 'req-2' } as any,
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookRequired: false, responseHookName: 'stop_message_auto' },
        baseObject: { ok: true }
      })
    ).resolves.toEqual({
      action: 'return_auto_hook_result',
      result: {
        mode: 'tool_flow',
        finalChatResponse: { ok: true },
        execution: { flowId: 'flow_1' }
      }
    });
    expect(runServertoolAutoHookCaller).toHaveBeenCalledTimes(1);
  });

  test('keeps missing auto-hook result contract errors out of the TS shell', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.ts',
      'utf8'
    );

    expect(source).not.toContain('[servertool] native response-stage requested auto-hook result but result was empty');
    expect(source).not.toContain('if (!autoHookResult)');
    expect(source).not.toContain('Boolean(autoHookResult)');
    expect(source).not.toContain("if (preAutoHookRuntimeAction.action === 'return_passthrough_bypass')");
    expect(source).not.toContain("if (postAutoHookRuntimeAction.action === 'return_required_response_hook_empty')");
    expect(source).not.toContain("if (postAutoHookRuntimeAction.action === 'return_auto_hook_result')");
    expect(source).not.toContain('function hasServerSideToolEngineResult(');
    expect(source).not.toContain('hasServerSideToolEngineResult(autoHookResult)');
    expect(source).not.toContain('switch (preAutoHookRuntimeAction.action)');
    expect(source).not.toContain('switch (postAutoHookRuntimeAction.action)');
    expect(source).not.toContain('hasAutoHookResult: autoHookResult != null');
    expect(source).toContain('autoHookResult');
    expect(source).not.toContain('if (autoHookResult == null)');
    expect(source).not.toContain('return preAutoHookRuntimeAction.passResult');
    expect(source).not.toContain('return postAutoHookRuntimeAction.passResult');
    expect(source).toContain('resolveServertoolResponseStageAutoHookPreDecisionWithNative({');
    expect(source).toContain('resolveServertoolResponseStageAutoHookPostDecisionWithNative({');
    expect(source).toContain('return preAutoHookDecision.result');
    expect(source).toContain('return postAutoHookDecision.result');
    expect(source).not.toContain("return { action: 'return_passthrough_bypass' }");
    expect(source).not.toContain("return { action: 'continue_without_result' }");
    expect(source).not.toContain("action: 'return_auto_hook_result',");
    expect(source).not.toContain('result: autoHookResult as ServerSideToolEngineResult');
    expect(source).not.toContain('responseHookName: postAutoHookRuntimeAction.responseHookName as string');
  });

  test('throws required hook empty when native plan demands it', async () => {
    runServertoolAutoHookCaller.mockResolvedValue(null);

    await expect(
      runServertoolResponseStageAutoHookPass({
        options: { requestId: 'req-3' } as any,
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookRequired: true, responseHookName: 'stop_message_auto' },
        baseObject: { ok: true }
      })
    ).rejects.toThrow('required hook empty: stop_message_auto');
  });

  test('fails fast for unknown pre auto-hook native action', async () => {
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValueOnce({
      action: 'unknown_pre_auto_hook_action'
    });

    await expect(
      runServertoolResponseStageAutoHookPass({
        options: { requestId: 'req-unknown-pre' } as any,
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookRequired: false },
        baseObject: { ok: true }
      })
    ).rejects.toThrow('[servertool] invalid response-stage pre auto-hook action');
    expect(runServertoolAutoHookCaller).not.toHaveBeenCalled();
  });

  test('fails fast for unknown post auto-hook native action', async () => {
    planServertoolResponseStageRuntimeActionWithNative.mockImplementation((input: any) => {
      if (input?.autoHookEvaluated === false) {
        return { action: 'run_auto_hooks' };
      }
      return { action: 'unknown_post_auto_hook_action' };
    });

    await expect(
      runServertoolResponseStageAutoHookPass({
        options: { requestId: 'req-unknown-post' } as any,
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookRequired: false },
        baseObject: { ok: true }
      })
    ).rejects.toThrow('[servertool] invalid response-stage post auto-hook action');
    expect(runServertoolAutoHookCaller).toHaveBeenCalledTimes(1);
  });
});
