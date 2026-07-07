import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const resolveServertoolEntryContext = jest.fn();
const runServertoolResponseStagePrePass = jest.fn();
const runServertoolExecutionStage = jest.fn();
const runServertoolResponseStageWithNative = jest.fn();
const isAdapterClientDisconnectedWithNative = jest.fn(() => false);
const readServertoolEntryBaseObjectWithNative = jest.fn((chatResponse: unknown) =>
  chatResponse != null && typeof chatResponse === 'object' && !Array.isArray(chatResponse)
    ? chatResponse
    : null
);
const resolveServertoolEntryPreflightWithNative = jest.fn((input: any) => ({
  action: 'continue',
  baseObject: input.baseObject
}));
const resolveServertoolEntryPreflightApplicationWithNative = jest.fn((input: any) => {
  if (input.entryPreflight.action === 'throw_error') {
    return { throwError: true, errorPlan: input.entryPreflight.errorPlan };
  }
  if (input.entryPreflight.action === 'return_result') {
    return { throwError: false, returnResult: true, result: input.entryPreflight.result };
  }
  return { throwError: false, returnResult: false, baseObject: input.entryPreflight.baseObject };
});
const resolveServertoolRunEngineEntryPreflightDecisionWithNative = jest.fn((input: any) => input.entryPreflight);
const resolveServertoolRunEngineEntryPreflightApplicationWithNative = jest.fn((input: any) =>
  input.entryPreflight.action === 'return_result'
    ? { returnResult: true, result: input.entryPreflight.result }
    : { returnResult: false, baseObject: input.entryPreflight.baseObject }
);
const resolveServertoolRunEnginePrepassDecisionWithNative = jest.fn();
const resolveServertoolRunEnginePrepassApplicationWithNative = jest.fn((input: any) =>
  input.decision.action === 'return_result'
    ? { returnResult: true, result: input.decision.result }
    : { returnResult: false }
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
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    isAdapterClientDisconnectedWithNative,
    readServertoolEntryBaseObjectWithNative,
    resolveServertoolEntryPreflightApplicationWithNative,
    resolveServertoolEntryPreflightWithNative,
    resolveServertoolRunEngineEntryPreflightDecisionWithNative,
    resolveServertoolRunEngineEntryPreflightApplicationWithNative,
    resolveServertoolRunEnginePrepassApplicationWithNative,
    resolveServertoolRunEnginePrepassDecisionWithNative,
    runServertoolResponseStageWithNative
  })
);

const createServertoolProviderProtocolErrorFromPlan = jest.fn((plan: any) => {
  const err = new Error(String(plan?.message ?? 'servertool error'));
  (err as Error & { code?: string }).code = String(plan?.code ?? 'SERVERTOOL_ENTRY_PREFLIGHT_ERROR');
  return err;
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan
  })
);

const { orchestrateServertoolEngine } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js'
);

describe('run-server-side-tool-engine-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isAdapterClientDisconnectedWithNative.mockReturnValue(false);
    readServertoolEntryBaseObjectWithNative.mockImplementation((chatResponse: unknown) =>
      chatResponse != null && typeof chatResponse === 'object' && !Array.isArray(chatResponse)
        ? chatResponse
        : null
    );
    resolveServertoolEntryPreflightWithNative.mockImplementation((input: any) => ({
      action: 'continue',
      baseObject: input.baseObject
    }));
    resolveServertoolEntryPreflightApplicationWithNative.mockImplementation((input: any) => {
      if (input.entryPreflight.action === 'throw_error') {
        return { throwError: true, errorPlan: input.entryPreflight.errorPlan };
      }
      if (input.entryPreflight.action === 'return_result') {
        return { throwError: false, returnResult: true, result: input.entryPreflight.result };
      }
      return { throwError: false, returnResult: false, baseObject: input.entryPreflight.baseObject };
    });
    resolveServertoolRunEngineEntryPreflightDecisionWithNative.mockImplementation((input: any) => input.entryPreflight);
    resolveServertoolRunEngineEntryPreflightApplicationWithNative.mockImplementation((input: any) =>
      input.entryPreflight.action === 'return_result'
        ? { returnResult: true, result: input.entryPreflight.result }
        : { returnResult: false, baseObject: input.entryPreflight.baseObject }
    );
    resolveServertoolRunEnginePrepassDecisionWithNative.mockReturnValue({
      action: 'continue_to_execution'
    });
    resolveServertoolRunEnginePrepassApplicationWithNative.mockImplementation((input: any) =>
      input.decision.action === 'return_result'
        ? { returnResult: true, result: input.decision.result }
        : { returnResult: false }
    );
    runServertoolResponseStageWithNative.mockReturnValue({
      normalizedPayload: { ok: true },
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }]
    });
  });

  test('owns the full engine orchestration chain as a dedicated shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts',
        'utf8'
      )
    );

    expect(source).not.toContain("from './entry-preflight-shell.js'");
    expect(source).not.toContain('runServertoolEntryPreflight');
    expect(source).toContain('resolveServertoolEntryPreflightWithNative');
    expect(source).toContain('resolveServertoolEntryPreflightApplicationWithNative');
    expect(source).toContain('readServertoolEntryBaseObjectWithNative(options.chatResponse)');
    expect(source).toContain('isAdapterClientDisconnectedWithNative(options.adapterContext)');
    expect(source).toContain('createServertoolProviderProtocolErrorFromPlan');
    expect(source).toContain('chatResponse: options.chatResponse');
    expect(source).toContain('entryPreflightApplication.errorPlan');
    expect(source).toContain('runServertoolResponseStageWithNative');
    expect(source).toContain('applyServertoolResponseStageExtraction');
    expect(source).not.toContain('extractToolCallsFromResponseStage');
    expect(source).toContain('resolveServertoolEntryContext');
    expect(source).toContain('runServertoolResponseStagePrePass');
    expect(source).toContain('runServertoolExecutionStage');
    expect(source).not.toContain("if (entryPreflight.action === 'return_result')");
    expect(source).not.toContain("if (entryContext.action !== 'continue')");
    expect(source).not.toContain("if (responseStagePrePass.action === 'return_result')");
    expect(source).toContain('resolveServertoolRunEngineEntryPreflightDecisionWithNative');
    expect(source).toContain('resolveServertoolRunEngineEntryPreflightApplicationWithNative');
    expect(source).toContain('resolveServertoolRunEnginePrepassDecisionWithNative');
    expect(source).toContain('resolveServertoolRunEnginePrepassApplicationWithNative');
    expect(source).not.toContain("entryPreflightDecision.action === 'return_result'");
    expect(source).not.toContain("enginePrepassDecision.action === 'return_result'");
    expect(source).not.toContain('switch (entryPreflight.action)');
    expect(source).not.toContain('switch (enginePrepassAction.action)');
    expect(source).toContain('prepassResult');
    expect(source).toContain('return enginePrepassApplication.result;');
    expect(source).not.toContain('return prepassResult;');
    expect(source).not.toContain('native engine prepass requested result but prepass result was empty');
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

  test('fails fast when native entry preflight decision rejects action', async () => {
    resolveServertoolRunEngineEntryPreflightDecisionWithNative.mockImplementation(() => {
      throw new Error('[servertool] invalid entry preflight result action');
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

    expect(runServertoolResponseStageWithNative).not.toHaveBeenCalled();
    expect(resolveServertoolEntryContext).not.toHaveBeenCalled();
    expect(runServertoolResponseStagePrePass).not.toHaveBeenCalled();
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });

  test('throws native entry preflight error through provider protocol projector', async () => {
    resolveServertoolEntryPreflightApplicationWithNative.mockReturnValue({
      throwError: true,
      errorPlan: {
        message: '[servertool] client disconnected: req-entry-error',
        code: 'SERVERTOOL_CLIENT_DISCONNECTED'
      }
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-entry-error',
        providerProtocol: 'openai-responses'
      } as any)
    ).rejects.toThrow('[servertool] client disconnected: req-entry-error');

    expect(createServertoolProviderProtocolErrorFromPlan).toHaveBeenCalledWith({
      message: '[servertool] client disconnected: req-entry-error',
      code: 'SERVERTOOL_CLIENT_DISCONNECTED'
    });
    expect(runServertoolResponseStageWithNative).not.toHaveBeenCalled();
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });

  test('fails fast when native engine prepass decision rejects action', async () => {
    runServertoolResponseStageWithNative.mockReturnValue({
      normalizedPayload: { ok: true },
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }]
    });
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
    resolveServertoolRunEnginePrepassDecisionWithNative.mockImplementation(() => {
      throw new Error('[servertool] invalid engine prepass action');
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
    resolveServertoolEntryPreflightApplicationWithNative.mockReturnValue({
      throwError: false,
      returnResult: true,
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
    expect(runServertoolResponseStageWithNative).not.toHaveBeenCalled();
  });

  test('forwards pre-pass early result without entering execution stage', async () => {
    runServertoolResponseStageWithNative.mockReturnValue({
      normalizedPayload: { ok: true },
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }]
    });
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
    resolveServertoolRunEnginePrepassDecisionWithNative.mockReturnValue({
      action: 'return_result',
      result: { mode: 'passthrough', finalChatResponse: { early: true } }
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
    expect(resolveServertoolRunEnginePrepassDecisionWithNative).toHaveBeenCalledWith({
      hasPrepassResult: true,
      prepassResult: { mode: 'passthrough', finalChatResponse: { early: true } }
    });
    expect(resolveServertoolRunEnginePrepassApplicationWithNative).toHaveBeenCalledWith({
      decision: {
        action: 'return_result',
        result: { mode: 'passthrough', finalChatResponse: { early: true } }
      }
    });
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });

  test('uses Rust engine prepass action before entering execution stage', async () => {
    runServertoolResponseStageWithNative.mockReturnValue({
      normalizedPayload: { ok: true },
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }]
    });
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
    expect(resolveServertoolRunEnginePrepassDecisionWithNative).toHaveBeenCalledWith({
      hasPrepassResult: false,
      prepassResult: null
    });
    expect(resolveServertoolRunEnginePrepassApplicationWithNative).toHaveBeenCalledWith({
      decision: { action: 'continue_to_execution' }
    });
    expect(runServertoolExecutionStage).toHaveBeenCalled();
  });
});
