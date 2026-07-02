import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runServertoolEntryPreflight = jest.fn();
const extractToolCallsFromResponseStage = jest.fn();
const resolveServertoolEntryContext = jest.fn();
const runServertoolResponseStagePrePass = jest.fn();
const runServertoolExecutionStage = jest.fn();
const planServertoolEnginePrepassActionWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/entry-preflight-shell.js',
  () => ({
    runServertoolEntryPreflight
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/extract-tool-calls-shell.js',
  () => ({
    extractToolCallsFromResponseStage
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/entry-context-shell.js',
  () => ({
    resolveServertoolEntryContext
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-prepass-shell.js',
  () => ({
    runServertoolResponseStagePrePass
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.js',
  () => ({
    runServertoolExecutionStage
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolEnginePrepassActionWithNative
  })
);

const { orchestrateServertoolEngine } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js'
);

describe('run-server-side-tool-engine-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolEnginePrepassActionWithNative.mockReturnValue({
      action: 'continue_to_execution'
    });
  });

  test('owns the full engine orchestration chain as a dedicated shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('runServertoolEntryPreflight');
    expect(source).toContain('extractToolCallsFromResponseStage');
    expect(source).toContain('resolveServertoolEntryContext');
    expect(source).toContain('runServertoolResponseStagePrePass');
    expect(source).toContain('runServertoolExecutionStage');
    expect(source).not.toContain("if (entryPreflight.action === 'return_result')");
    expect(source).not.toContain("if (entryContext.action !== 'continue')");
    expect(source).not.toContain("if (responseStagePrePass.action === 'return_result')");
    expect(source).toContain('planServertoolEnginePrepassActionWithNative');
    expect(source).toContain('switch (entryPreflight.action)');
    expect(source).toContain('switch (enginePrepassAction.action)');
    expect(source).not.toContain('switch (responseStagePrePass.action)');
    expect(source).not.toContain('const entryPreflightAction = entryPreflight.action');
    expect(source).not.toContain('const entryContextAction = entryContext.action');
    expect(source).not.toContain('const responseStagePrePassAction = responseStagePrePass.action');
    expect(source).not.toContain('entryPreflight as { action: unknown }');
    expect(source).not.toContain('enginePrepassAction as { action: unknown }');
    expect(source).not.toContain('contextBase: entryContext.contextBase as ServerToolHandlerContext');
    expect(source).not.toContain('ServerToolHandlerContext');
    expect(source).toContain('contextBase: entryContext.contextBase');
    expect(source).not.toContain('const base =');
    expect(source).not.toContain("typeof options.chatResponse === 'object'");
    expect(source).not.toContain("case 'return_non_object_base':");
    expect(source).not.toContain('invalid entry context action');
  });

  test('fails fast on unknown entry preflight action without reading action payload in TS', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'unknown_entry_preflight_action'
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-unknown-entry-preflight',
        providerProtocol: 'openai-responses'
      } as any)
    ).rejects.toThrow('[servertool] invalid entry preflight result action');

    expect(extractToolCallsFromResponseStage).not.toHaveBeenCalled();
    expect(resolveServertoolEntryContext).not.toHaveBeenCalled();
    expect(runServertoolResponseStagePrePass).not.toHaveBeenCalled();
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });

  test('fails fast on unknown engine prepass action without reading action payload in TS', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true }
    });
    extractToolCallsFromResponseStage.mockReturnValue([{ id: 'call_1', name: 'web_search' }]);
    resolveServertoolEntryContext.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true },
      contextBase: { base: { ok: true }, toolCalls: [], adapterContext: {}, requestId: 'req-unknown-prepass', entryEndpoint: 'openai', providerProtocol: 'openai-chat' },
      includeToolCallNames: null,
      excludeToolCallNames: null,
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });
    runServertoolResponseStagePrePass.mockResolvedValue({
      action: 'continue_to_execution',
      responseStageGatePlan: { nextAction: 'continue_to_execution' }
    });
    planServertoolEnginePrepassActionWithNative.mockReturnValue({
      action: 'unknown_engine_prepass_action'
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-unknown-prepass',
        providerProtocol: 'openai-responses'
      } as any)
    ).rejects.toThrow('[servertool] invalid engine prepass action');

    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });

  test('returns preflight early result when preflight short-circuits', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'return_result',
      result: { mode: 'passthrough', finalChatResponse: { ok: 'short' } }
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-preflight',
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({ mode: 'passthrough', finalChatResponse: { ok: 'short' } });
    expect(extractToolCallsFromResponseStage).not.toHaveBeenCalled();
  });

  test('forwards pre-pass early result without entering execution stage', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true }
    });
    extractToolCallsFromResponseStage.mockReturnValue([{ id: 'call_1', name: 'web_search' }]);
    resolveServertoolEntryContext.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true },
      contextBase: { base: { ok: true }, toolCalls: [], adapterContext: {}, requestId: 'req-pass', entryEndpoint: 'openai', providerProtocol: 'openai-chat' },
      includeToolCallNames: null,
      excludeToolCallNames: null,
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });
    runServertoolResponseStagePrePass.mockResolvedValue({
      action: 'return_result',
      result: { mode: 'passthrough', finalChatResponse: { early: true } }
    });
    planServertoolEnginePrepassActionWithNative.mockReturnValue({
      action: 'return_prepass_result'
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-pass',
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({ mode: 'passthrough', finalChatResponse: { early: true } });
    expect(planServertoolEnginePrepassActionWithNative).toHaveBeenCalledWith({
      hasPrepassResult: true
    });
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });

  test('uses Rust engine prepass action before entering execution stage', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true }
    });
    extractToolCallsFromResponseStage.mockReturnValue([{ id: 'call_1', name: 'web_search' }]);
    resolveServertoolEntryContext.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true },
      contextBase: { base: { ok: true }, toolCalls: [], adapterContext: {}, requestId: 'req-pass', entryEndpoint: 'openai', providerProtocol: 'openai-chat' },
      includeToolCallNames: null,
      excludeToolCallNames: null,
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });
    runServertoolResponseStagePrePass.mockResolvedValue({
      action: 'continue_to_execution',
      responseStageGatePlan: { nextAction: 'continue_to_execution' }
    });
    runServertoolExecutionStage.mockResolvedValue({
      mode: 'passthrough',
      finalChatResponse: { executed: true }
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-pass',
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({ mode: 'passthrough', finalChatResponse: { executed: true } });
    expect(planServertoolEnginePrepassActionWithNative).toHaveBeenCalledWith({
      hasPrepassResult: false
    });
    expect(runServertoolExecutionStage).toHaveBeenCalled();
  });
});
