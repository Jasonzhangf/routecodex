import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinAutoHandlerEntriesMock = jest.fn();
const planServertoolRegistryLookupFromSkeletonWithNativeMock = jest.fn();
const resolveServertoolRegistryHandlerWithNativeMock = jest.fn((input: any) => {
  const actionPlan = planServertoolRegistryLookupFromSkeletonWithNativeMock({
    name: typeof input?.name === 'string' ? input.name : ''
  });
  switch (actionPlan.action) {
    case 'return_builtin':
      return getBuiltinHandlerEntryMock({ name: actionPlan.canonicalName });
    case 'return_none':
      return null;
    default:
      throw new Error('[servertool] invalid registry lookup action');
  }
});
const planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock = jest.fn();
const planServertoolAutoHookQueueItemsWithNativeMock = jest.fn((input: any) => ({
  queueOrder: [
    { queue: 'A_optional', entries: input?.hooks ?? [] },
    { queue: 'B_mandatory', entries: [] }
  ]
}));
const runStoplessBuiltinHandlerForRuntimeWithNativeMock = jest.fn(async () => null);
const resolveAutoHookRuntimeAttemptDecisionWithNativeMock = jest.fn(() => ({
  traceEvent: {
    hookId: 'alpha',
    phase: 'post',
    priority: 9,
    queue: 'A_optional',
    queueIndex: 1,
    queueTotal: 1,
    result: 'miss',
    reason: 'predicate_false'
  },
  returnResult: false,
  rethrowError: false,
  continueQueue: true
}));
const resolveAutoHookCallerFinalizationDecisionWithNativeMock = jest.fn(() => ({
  returnResult: false,
  returnNull: true,
  continueNextQueue: false
}));
const createServertoolExecutionLoopStateWithNativeMock = jest.fn(() => ({
  executedToolCalls: [],
  executedIds: [],
  executedFlowIds: []
}));
const resolveServertoolExecutionLoopInitialDecisionWithNativeMock = jest.fn(() => ({
  action: 'skip_non_tool_call_handler'
}));
const applyServertoolExecutionLoopInitialDecisionWithNativeMock = jest.fn((decision: any, application: any) => {
  if (decision?.action === 'skip_non_tool_call_handler') {
    return application.skipNonToolCallHandler();
  }
  throw new Error('[servertool] unexpected registry test action');
});

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    planServertoolBuiltinAutoHandlerEntriesWithNative: listBuiltinAutoHandlerEntriesMock,
    planServertoolRegistryLookupFromSkeletonWithNative: planServertoolRegistryLookupFromSkeletonWithNativeMock,
    resolveServertoolBuiltinHandlerEntryWithNative: getBuiltinHandlerEntryMock,
    resolveServertoolRegistryHandlerWithNative: resolveServertoolRegistryHandlerWithNativeMock,
    materializeServertoolPlannedResultWithNative: jest.fn(),
    createServertoolProviderProtocolErrorFromPlanWithNative: jest.fn(),
    planServertoolTimeoutWatcherWithNative: jest.fn(() => ({ armed: false, timeoutMs: 0 })),
    buildServertoolHandlerErrorToolOutputPayloadWithNative: jest.fn(),
    planServertoolToolCallDispatchWithNative: jest.fn(),
    planServertoolExecutionDispatchErrorWithNative: jest.fn(),
    appendServertoolExecutedRecordWithNative: jest.fn(),
    createServertoolExecutionLoopStateWithNative: createServertoolExecutionLoopStateWithNativeMock,
    planServertoolHandlerErrorExecutionLoopEffectWithNative: jest.fn(),
    resolveServertoolExecutionLoopInitialDecisionWithNative:
      resolveServertoolExecutionLoopInitialDecisionWithNativeMock,
    resolveServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopInitialDecisionWithNative:
      applyServertoolExecutionLoopInitialDecisionWithNativeMock,
    applyServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    runStoplessBuiltinHandlerForRuntimeWithNative: runStoplessBuiltinHandlerForRuntimeWithNativeMock,
    resolveAutoHookCallerFinalizationDecisionWithNative:
      resolveAutoHookCallerFinalizationDecisionWithNativeMock,
    resolveAutoHookRuntimeAttemptDecisionWithNative:
      resolveAutoHookRuntimeAttemptDecisionWithNativeMock,
    planServertoolAutoHookQueueItemsWithNative: planServertoolAutoHookQueueItemsWithNativeMock,
    planServertoolRegistryBuiltinAutoHookEntriesWithNative:
      planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock,
  })
);

const {
  runServertoolIoExecutionQueue,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js'
);
const {
  runServertoolAutoHookCaller,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js'
);

async function runQueueRegistryLookup(name: string): Promise<void> {
  await runServertoolIoExecutionQueue({
    dispatchPlan: {
      executableToolCalls: [
        {
          id: `call-${name}`,
          name,
          arguments: '{}',
          executionMode: 'guarded',
          stripAfterExecute: false
        }
      ],
      noopToolCalls: []
    } as any,
    options: { requestId: `req-${name}` } as any,
    contextBase: {
      base: {},
      toolCalls: [],
      adapterContext: {},
      requestId: `req-${name}`,
      entryEndpoint: 'openai',
      providerProtocol: 'openai-chat'
    } as any,
    baseForExecution: {} as any
  });
}

describe('registry-orchestration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBuiltinAutoHandlerEntriesMock.mockReturnValue({ entries: [] });
    planServertoolAutoHookQueueItemsWithNativeMock.mockImplementation((input: any) => ({
      queueOrder: [
        { queue: 'A_optional', entries: input?.hooks ?? [] },
        { queue: 'B_mandatory', entries: [] }
      ]
    }));
    runStoplessBuiltinHandlerForRuntimeWithNativeMock.mockResolvedValue(null);
    resolveAutoHookRuntimeAttemptDecisionWithNativeMock.mockReturnValue({
      traceEvent: {
        hookId: 'alpha',
        phase: 'post',
        priority: 9,
        queue: 'A_optional',
        queueIndex: 1,
        queueTotal: 1,
        result: 'miss',
        reason: 'predicate_false'
      },
      returnResult: false,
      rethrowError: false,
      continueQueue: true
    });
    resolveAutoHookCallerFinalizationDecisionWithNativeMock.mockReturnValue({
      returnResult: false,
      returnNull: true,
      continueNextQueue: false
    });
  });

  test('queue uses native builtin registry entry and ignores retired ad-hoc lookup plans', async () => {
    const builtin = {
      name: 'builtin',
      trigger: 'tool_call',
      registration: { executionMode: 'guarded' },
      execution: { kind: 'builtin', builtinName: 'builtin' }
    };
    getBuiltinHandlerEntryMock.mockReturnValue(builtin);

    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'return_builtin',
      canonicalName: 'builtin',
    });
    await runQueueRegistryLookup('Builtin');
    expect(getBuiltinHandlerEntryMock).toHaveBeenCalledWith({ name: 'builtin' });
    expect(resolveServertoolExecutionLoopInitialDecisionWithNativeMock).toHaveBeenLastCalledWith({
      hasHandlerEntry: true,
      triggerMode: 'tool_call',
      nativeExecutionMode: 'guarded',
      tsExecutionMode: 'guarded'
    });

    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'return_none',
    });
    await runQueueRegistryLookup('adhoc');
    expect(resolveServertoolExecutionLoopInitialDecisionWithNativeMock).toHaveBeenLastCalledWith({
      hasHandlerEntry: false,
      triggerMode: undefined,
      nativeExecutionMode: undefined,
      tsExecutionMode: 'guarded'
    });
  });

  test('fails fast when native registry lookup returns an unknown action', async () => {
    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'unknown_registry_action',
    });

    await expect(runQueueRegistryLookup('unknown')).rejects.toThrow(
      '[servertool] invalid registry lookup action'
    );
    expect(getBuiltinHandlerEntryMock).not.toHaveBeenCalled();
    expect(resolveServertoolExecutionLoopInitialDecisionWithNativeMock).not.toHaveBeenCalled();
  });

  test('projects auto-hook descriptors directly through native descriptor planner', async () => {
    const execution = { kind: 'builtin', builtinName: 'alpha' };
    const entry = {
      name: 'alpha',
      trigger: 'auto',
      registration: { name: 'alpha', trigger: 'auto' },
      execution,
      autoHook: { phase: 'post', priority: 9, order: 1 },
    } as any;
    listBuiltinAutoHandlerEntriesMock.mockReturnValue({ entries: [entry] });
    planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock.mockReturnValue([
      {
        id: 'alpha',
        phase: 'post',
        priority: 9,
        order: 1,
        registration: entry.registration,
        execution,
      },
    ]);

    await runServertoolAutoHookCaller({
      options: {
        requestId: 'req-alpha',
        chatResponse: {},
        adapterContext: {},
        entryEndpoint: '/v1/chat/completions'
      } as any,
      contextBase: {
        base: {},
        toolCalls: [],
        adapterContext: {},
        requestId: 'req-alpha',
        entryEndpoint: '/v1/chat/completions'
      } as any,
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });

    expect(planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock).toHaveBeenCalledWith({
      hooks: [
        {
          id: 'alpha',
          phase: 'post',
          priority: 9,
          order: 1,
          registration: entry.registration,
          execution,
        },
      ],
    });
    expect(planServertoolAutoHookQueueItemsWithNativeMock).toHaveBeenCalledWith({
      hooks: [
        {
          id: 'alpha',
          phase: 'post',
          priority: 9,
          order: 1,
          registration: entry.registration,
          execution,
        },
      ],
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });
  });

  test('surfaces native builtin auto-hook entry contract failures without TS sourceIndex rematch', async () => {
    listBuiltinAutoHandlerEntriesMock.mockReturnValue({ entries: [] });
    planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock.mockImplementation(() => {
      throw new Error(
        'planServertoolRegistryAutoHookDescriptorsJson native returned descriptor without builtin hook sourceIndex: 1'
      );
    });

    await expect(
      runServertoolAutoHookCaller({
        options: {
          requestId: 'req-alpha-failure',
          chatResponse: {},
          adapterContext: {},
          entryEndpoint: '/v1/chat/completions'
        } as any,
        contextBase: {
          base: {},
          toolCalls: [],
          adapterContext: {},
          requestId: 'req-alpha-failure',
          entryEndpoint: '/v1/chat/completions'
        } as any,
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).rejects.toThrow('native returned descriptor without builtin hook sourceIndex: 1');
  });

  test('registry orchestration shell owns builtin lookup but not name normalization', async () => {
    const fs = await import('node:fs/promises');
    const lookupSource = await fs.readFile('sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts', 'utf8');
    const hookSource = await fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8');
    const source = `${lookupSource}\n${hookSource}`;
    await expect(
      fs.access('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts')
    ).rejects.toThrow();

    expect(source).not.toContain('function resolveBuiltinEntry(');
    expect(source).not.toContain('.trim().toLowerCase()');
    expect(source).not.toContain("if (actionPlan.action === 'return_builtin')");
    expect(source).not.toContain('switch (actionPlan.action)');
    expect(source).not.toContain("case 'return_none':");
    expect(source).not.toContain('invalid registry lookup action');
    expect(source).not.toContain("planServertoolRegistryLookupFromSkeletonWithNative({");
    expect(source).toContain('resolveServertoolRegistryHandlerWithNative({');
    expect(source).toContain('planServertoolRegistryBuiltinAutoHookEntriesWithNative({');
    expect(source).not.toContain("from './registry-projection-shell.js'");
    expect(source).not.toContain('getServerToolHandlerViaNativePlan');
  });

  test('keeps native builtin lookup contract errors out of the TS shell', async () => {
    const source = await import('node:fs/promises').then(async (fs) =>
      `${await fs.readFile('sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts', 'utf8')}\n${await fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')}`
    );

    expect(source).not.toContain('native registry lookup returned builtin without canonicalName');
    expect(source).not.toContain('if (!actionPlan.canonicalName)');
    expect(source).not.toContain('actionPlan.canonicalName as string');
    expect(source).not.toContain('name: actionPlan.canonicalName');
  });

  test('does not keep a registered-name wrapper around skeleton config', async () => {
    const source = await import('node:fs/promises').then(async (fs) =>
      `${await fs.readFile('sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts', 'utf8')}\n${await fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')}`
    );

    expect(source).not.toContain('export function isRegisteredServerToolName(');
    expect(source).not.toContain('resolveServertoolRegisteredNameWithNative');
    expect(source).not.toContain('isRegisteredServerToolNameViaNativeConfig');
    expect(source).not.toContain('isServertoolRegisteredNameByConfig');
  });

  test('does not rematch native auto-hook descriptors by sourceIndex in TS', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')
    );

    expect(source).not.toContain('descriptor.sourceIndex');
    expect(source).not.toContain('native registry auto-hook descriptor missing entry');
    expect(source).toContain('const listAutoServerToolHooks =');
    expect(source).not.toContain('export const listAutoServerToolHooks');
    expect(source).toContain('planServertoolRegistryBuiltinAutoHookEntriesWithNative({');
    expect(source).not.toContain('registration: entry.registration as unknown as Record<string, unknown>');
    expect(source).not.toContain('execution: entry.execution as Record<string, unknown>');
  });
});
