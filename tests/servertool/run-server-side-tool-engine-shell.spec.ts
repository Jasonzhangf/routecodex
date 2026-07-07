import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runServertoolExecutionStage = jest.fn();
const runServertoolResponseStageWithNative = jest.fn();
const runServertoolResponseStageAutoHookPass = jest.fn();
const readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter = jest.fn(() => ({
  runtimeControl: { providerProtocol: 'openai-responses' }
}));
const readRuntimeControlFromAnyBoundMetadataCenter = jest.fn(() => undefined);
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
const planServertoolEntryContextWithNative = jest.fn(() => ({
  includeToolCallNames: null,
  excludeToolCallNames: null,
  includeAutoHookIds: null,
  excludeAutoHookIds: null
}));
const planServertoolResponseStageGateWithNative = jest.fn(() => ({
  responseHookMatched: false,
  responseHookRequired: false,
  nextAction: 'continue_to_execution'
}));
const resolveServertoolResponseStagePrepassInitialDecisionWithNative = jest.fn(() => ({
  action: 'return_prepass_result',
  result: {
    action: 'continue_to_execution',
    responseStageGatePlan: {
      responseHookMatched: false,
      responseHookRequired: false,
      nextAction: 'continue_to_execution'
    }
  }
}));
const resolveServertoolResponseStagePrepassInitialApplicationWithNative = jest.fn((input: any) =>
  input.decision.action === 'run_auto_hooks'
    ? { runAutoHook: true }
    : { runAutoHook: false, result: input.decision.result }
);
const resolveServertoolResponseStagePrepassAfterAutoHookWithNative = jest.fn(() => ({
  result: {
    action: 'continue_to_execution',
    responseStageGatePlan: {
      responseHookMatched: false,
      responseHookRequired: false,
      nextAction: 'continue_to_execution'
    }
  }
}));
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
  '../../sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.js',
  () => ({
    runServertoolExecutionStage,
    runServertoolResponseStageAutoHookPass
  })
);

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    isAdapterClientDisconnectedWithNative,
    planServertoolEntryContextWithNative,
    planServertoolResponseStageGateWithNative,
    readServertoolEntryBaseObjectWithNative,
    resolveServertoolEntryPreflightApplicationWithNative,
    resolveServertoolEntryPreflightWithNative,
    resolveServertoolResponseStagePrepassAfterAutoHookWithNative,
    resolveServertoolResponseStagePrepassInitialApplicationWithNative,
    resolveServertoolResponseStagePrepassInitialDecisionWithNative,
    resolveServertoolRunEngineEntryPreflightDecisionWithNative,
    resolveServertoolRunEngineEntryPreflightApplicationWithNative,
    resolveServertoolRunEnginePrepassApplicationWithNative,
    resolveServertoolRunEnginePrepassDecisionWithNative,
    runServertoolResponseStageWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js',
  () => ({
    readRuntimeControlFromAnyBoundMetadataCenter,
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
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
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter.mockReturnValue({
      runtimeControl: { providerProtocol: 'openai-responses' }
    });
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
    planServertoolEntryContextWithNative.mockReturnValue({
      includeToolCallNames: null,
      excludeToolCallNames: null,
      includeAutoHookIds: null,
      excludeAutoHookIds: null
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
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: false,
      responseHookRequired: false,
      nextAction: 'continue_to_execution'
    });
    resolveServertoolResponseStagePrepassInitialDecisionWithNative.mockReturnValue({
      action: 'return_prepass_result',
      result: {
        action: 'continue_to_execution',
        responseStageGatePlan: {
          responseHookMatched: false,
          responseHookRequired: false,
          nextAction: 'continue_to_execution'
        }
      }
    });
    resolveServertoolResponseStagePrepassInitialApplicationWithNative.mockImplementation((input: any) =>
      input.decision.action === 'run_auto_hooks'
        ? { runAutoHook: true }
        : { runAutoHook: false, result: input.decision.result }
    );
    resolveServertoolResponseStagePrepassAfterAutoHookWithNative.mockReturnValue({
      result: {
        action: 'continue_to_execution',
        responseStageGatePlan: {
          responseHookMatched: false,
          responseHookRequired: false,
          nextAction: 'continue_to_execution'
        }
      }
    });
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'continue_without_result'
    });
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
    expect(source).not.toContain("from './entry-context-shell.js'");
    expect(source).not.toContain('resolveServertoolEntryContext');
    expect(source).toContain('readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter');
    expect(source).toContain('planServertoolEntryContextWithNative');
    expect(source).toContain('return tokens != null ? new Set(tokens) : null;');
    expect(source).toContain('runtimeMetadata: runtimeMetadataSnapshot');
    expect(source).not.toContain("from './response-stage-prepass-shell.js'");
    expect(source).not.toContain('runServertoolResponseStagePrePass');
    expect(source).toContain('applyServertoolResponseStagePrePass');
    expect(source).toContain('planServertoolResponseStageGateWithNative');
    expect(source).toContain('resolveServertoolResponseStagePrepassInitialDecisionWithNative');
    expect(source).toContain('resolveServertoolResponseStagePrepassInitialApplicationWithNative');
    expect(source).toContain('resolveServertoolResponseStagePrepassAfterAutoHookWithNative');
    expect(source).toContain('runServertoolResponseStageAutoHookPass');
    expect(source).toContain('readRuntimeControlFromAnyBoundMetadataCenter');
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
    expect(readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter).not.toHaveBeenCalled();
    expect(planServertoolEntryContextWithNative).not.toHaveBeenCalled();
    expect(planServertoolResponseStageGateWithNative).not.toHaveBeenCalled();
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

  test('fails fast when entry context metadata snapshot is absent', async () => {
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter.mockReturnValue(null);

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-no-metadata',
        providerProtocol: 'openai-responses'
      } as any)
    ).rejects.toThrow('Servertool entry context requires MetadataCenter request truth or runtime_control snapshot');

    expect(planServertoolEntryContextWithNative).not.toHaveBeenCalled();
    expect(planServertoolResponseStageGateWithNative).not.toHaveBeenCalled();
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });

  test('builds entry context from metadata snapshot and native filter plan', async () => {
    const adapterContext = { req: true };
    const metadataSnapshot = { runtimeControl: { providerProtocol: 'openai-responses' } };
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter.mockReturnValue(metadataSnapshot);
    planServertoolEntryContextWithNative.mockReturnValue({
      includeToolCallNames: ['web_search'],
      excludeToolCallNames: ['vision_auto'],
      includeAutoHookIds: ['stop_message_auto'],
      excludeAutoHookIds: ['memory_cache_auto']
    });
    runServertoolExecutionStage.mockResolvedValue({
      mode: 'passthrough',
      finalChatResponse: { executed: true }
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext,
        entryEndpoint: '/v1/responses',
        requestId: 'req-context',
        includeToolCallHandlerNames: [' Web_Search '],
        excludeToolCallHandlerNames: [' Vision_Auto '],
        includeAutoHookIds: [' Stop_Message_Auto '],
        excludeAutoHookIds: [' Memory_Cache_Auto '],
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({ mode: 'passthrough', finalChatResponse: { executed: true } });

    expect(readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter).toHaveBeenCalledWith(adapterContext);
    expect(planServertoolEntryContextWithNative).toHaveBeenCalledWith({
      includeToolCallHandlerNames: [' Web_Search '],
      excludeToolCallHandlerNames: [' Vision_Auto '],
      includeAutoHookIds: [' Stop_Message_Auto '],
      excludeAutoHookIds: [' Memory_Cache_Auto ']
    });
    expect(planServertoolResponseStageGateWithNative).toHaveBeenCalledWith({
      payload: { ok: true },
      adapterContext,
      runtimeControl: undefined,
      allowFollowup: false
    });
    expect(resolveServertoolResponseStagePrepassInitialDecisionWithNative).toHaveBeenCalledWith({
      responseStageGatePlan: {
        responseHookMatched: false,
        responseHookRequired: false,
        nextAction: 'continue_to_execution'
      },
      baseObject: { ok: true }
    });
    expect(runServertoolResponseStageAutoHookPass).not.toHaveBeenCalled();
    expect(runServertoolExecutionStage).toHaveBeenCalledWith(expect.objectContaining({
      includeToolCallNames: new Set(['web_search']),
      excludeToolCallNames: new Set(['vision_auto']),
      includeAutoHookIds: new Set(['stop_message_auto']),
      excludeAutoHookIds: new Set(['memory_cache_auto']),
      contextBase: expect.objectContaining({
        base: { ok: true },
        adapterContext,
        requestId: 'req-context',
        entryEndpoint: '/v1/responses',
        runtimeMetadata: metadataSnapshot
      }),
      responseStageGatePlan: {
        responseHookMatched: false,
        responseHookRequired: false,
        nextAction: 'continue_to_execution'
      }
    }));
  });

  test('forwards pre-pass early result without entering execution stage', async () => {
    runServertoolResponseStageWithNative.mockReturnValue({
      normalizedPayload: { ok: true },
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }]
    });
    resolveServertoolResponseStagePrepassInitialDecisionWithNative.mockReturnValue({
      action: 'return_prepass_result',
      result: {
        action: 'return_result',
        responseStageGatePlan: {
          responseHookMatched: false,
          responseHookRequired: false,
          nextAction: 'continue_to_execution'
        },
        result: { mode: 'passthrough', finalChatResponse: { early: true } }
      }
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

  test('runs inlined response-stage auto-hook prepass before engine execution', async () => {
    planServertoolResponseStageGateWithNative.mockReturnValue({
      responseHookMatched: true,
      responseHookRequired: false,
      nextAction: 'run_auto_hooks'
    });
    resolveServertoolResponseStagePrepassInitialDecisionWithNative.mockReturnValue({
      action: 'run_auto_hooks'
    });
    resolveServertoolResponseStagePrepassInitialApplicationWithNative.mockReturnValue({
      runAutoHook: true
    });
    runServertoolResponseStageAutoHookPass.mockResolvedValue({
      action: 'return_auto_hook_result',
      result: {
        mode: 'tool_flow',
        finalChatResponse: { done: true },
        execution: { flowId: 'flow_1' }
      }
    });
    resolveServertoolResponseStagePrepassAfterAutoHookWithNative.mockReturnValue({
      result: {
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
      }
    });
    resolveServertoolRunEnginePrepassDecisionWithNative.mockReturnValue({
      action: 'return_result',
      result: {
        mode: 'tool_flow',
        finalChatResponse: { done: true },
        execution: { flowId: 'flow_1' }
      }
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-inline-prepass-auto-hook',
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({
      mode: 'tool_flow',
      finalChatResponse: { done: true },
      execution: { flowId: 'flow_1' }
    });

    expect(runServertoolResponseStageAutoHookPass).toHaveBeenCalledWith(expect.objectContaining({
      responseStageGatePlan: {
        responseHookMatched: true,
        responseHookRequired: false,
        nextAction: 'run_auto_hooks'
      },
      baseObject: { ok: true }
    }));
    expect(resolveServertoolResponseStagePrepassAfterAutoHookWithNative).toHaveBeenCalledWith({
      responseStageGatePlan: {
        responseHookMatched: true,
        responseHookRequired: false,
        nextAction: 'run_auto_hooks'
      },
      baseObject: { ok: true },
      responseStageAutoHookResult: {
        action: 'return_auto_hook_result',
        result: {
          mode: 'tool_flow',
          finalChatResponse: { done: true },
          execution: { flowId: 'flow_1' }
        }
      }
    });
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });
});
