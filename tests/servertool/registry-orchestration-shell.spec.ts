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
    planServertoolNoopOutcomeWithNative: jest.fn(),
    buildServertoolHandlerErrorToolOutputPayloadWithNative: jest.fn(),
    planServertoolToolCallDispatchWithNative: jest.fn(),
    planServertoolExecutionDispatchErrorWithNative: jest.fn(),
    appendServertoolExecutedRecordWithNative: jest.fn(),
    createServertoolExecutionLoopStateWithNative: jest.fn(),
    planServertoolHandlerErrorExecutionLoopEffectWithNative: jest.fn(),
    planServertoolNoopExecutionLoopEffectWithNative: jest.fn(),
    resolveServertoolExecutionLoopInitialDecisionWithNative: jest.fn(),
    resolveServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopInitialDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(),
    resolveAutoHookCallerFinalizationDecisionWithNative: jest.fn(),
    resolveAutoHookRuntimeAttemptDecisionWithNative: jest.fn(),
    planServertoolAutoHookQueueItemsWithNative: jest.fn(),
    planServertoolRegistryBuiltinAutoHookEntriesWithNative:
      planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock,
  })
);

const {
  getServerToolHandler,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js'
);
const {
  listAutoServerToolHooks,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js'
);

describe('registry-orchestration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBuiltinAutoHandlerEntriesMock.mockReturnValue({ entries: [] });
  });

  test('returns builtin entry and ignores retired ad-hoc lookup plans', () => {
    const builtin = { name: 'builtin' };
    getBuiltinHandlerEntryMock.mockReturnValue(builtin);

    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'return_builtin',
      canonicalName: 'builtin',
    });
    expect(getServerToolHandler('Builtin')).toBe(builtin);

    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'return_none',
    });
    expect(getServerToolHandler('adhoc')).toBeUndefined();
  });

  test('fails fast when native registry lookup returns an unknown action', () => {
    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'unknown_registry_action',
    });

    expect(() => getServerToolHandler('unknown')).toThrow(
      '[servertool] invalid registry lookup action'
    );
    expect(getBuiltinHandlerEntryMock).not.toHaveBeenCalled();
  });

  test('projects auto-hook descriptors directly through native descriptor planner', () => {
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

    expect(listAutoServerToolHooks()).toEqual([
      {
        id: 'alpha',
        phase: 'post',
        priority: 9,
        order: 1,
        registration: entry.registration,
        execution,
      },
    ]);
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
  });

  test('surfaces native builtin auto-hook entry contract failures without TS sourceIndex rematch', () => {
    listBuiltinAutoHandlerEntriesMock.mockReturnValue({ entries: [] });
    planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock.mockImplementation(() => {
      throw new Error(
        'planServertoolRegistryAutoHookDescriptorsJson native returned descriptor without builtin hook sourceIndex: 1'
      );
    });

    expect(() => listAutoServerToolHooks()).toThrow(
      'native returned descriptor without builtin hook sourceIndex: 1'
    );
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
    expect(source).toContain('planServertoolRegistryBuiltinAutoHookEntriesWithNative({');
    expect(source).not.toContain('registration: entry.registration as unknown as Record<string, unknown>');
    expect(source).not.toContain('execution: entry.execution as Record<string, unknown>');
  });
});
