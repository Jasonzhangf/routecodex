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

const { runServertoolResponseStagePrePass } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-prepass-shell.js'
);

describe('response-stage-prepass-shell', () => {
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
        responseHookRequired: false
      }
    });
    expect(planServertoolResponseStageGateWithNative).toHaveBeenCalledWith({
      payload: { ok: true },
      adapterContext: { trace: true }
    });
    expect(runServertoolResponseStageAutoHookPass).not.toHaveBeenCalled();
  });

  test('returns early auto-hook result when matched response hook materializes one', async () => {
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: true,
      responseHookRequired: false
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
        responseHookRequired: false
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
          responseHookRequired: false
        }
      })
    );
  });
});
