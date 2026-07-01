import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runServertoolResponseStageAutoHookPass = jest.fn();

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
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'continue_without_result'
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
    expect(source).not.toContain('initialResponseStageGatePlan');
    expect(source).not.toContain('planServertoolResponseStageGateWithNative');
    expect(source).not.toContain('readRuntimeControlFromAnyBoundMetadataCenter');
    expect(source).not.toContain('responseHookMatched === true');
  });
});
