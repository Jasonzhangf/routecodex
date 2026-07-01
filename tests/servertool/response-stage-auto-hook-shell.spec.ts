import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolResponseStageRuntimeActionWithNative = jest.fn();
const planServertoolRequiredResponseHookEmptyErrorWithNative = jest.fn();
const runServertoolAutoHookCaller = jest.fn();
const createServertoolProviderProtocolErrorFromPlan = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolResponseStageRuntimeActionWithNative,
    planServertoolRequiredResponseHookEmptyErrorWithNative
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
        return { action: 'run_auto_hooks' };
      }
      if (input?.hasAutoHookResult === true) {
        return { action: 'return_auto_hook_result' };
      }
      if (input?.responseStageGatePlan?.responseHookRequired === true) {
        return {
          action: 'return_required_response_hook_empty',
          responseHookName: String(input?.responseStageGatePlan?.responseHookName ?? '').trim()
        };
      }
      return { action: 'return_passthrough_no_auto_hook_result' };
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
    planServertoolResponseStageRuntimeActionWithNative.mockReturnValue({ action: 'return_passthrough_bypass' });

    await expect(
      runServertoolResponseStageAutoHookPass({
        options: { requestId: 'req-1' } as any,
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookRequired: false }
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
        responseStageGatePlan: { responseHookRequired: false, responseHookName: 'stop_message_auto' }
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
    expect(source).toContain('switch (preAutoHookRuntimeAction.action)');
    expect(source).toContain('switch (postAutoHookRuntimeAction.action)');
    expect(source).toContain('hasAutoHookResult: autoHookResult !== null');
    expect(source).toContain('result: autoHookResult as ServerSideToolEngineResult');
  });

  test('throws required hook empty when native plan demands it', async () => {
    runServertoolAutoHookCaller.mockResolvedValue(null);

    await expect(
      runServertoolResponseStageAutoHookPass({
        options: { requestId: 'req-3' } as any,
        contextBase: {} as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null,
        responseStageGatePlan: { responseHookRequired: true, responseHookName: 'stop_message_auto' }
      })
    ).rejects.toThrow('required hook empty: stop_message_auto');
  });
});
