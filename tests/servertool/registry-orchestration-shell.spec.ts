import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinAutoHandlerEntriesMock = jest.fn();
const planServertoolRegistryLookupFromSkeletonWithNativeMock = jest.fn();
const planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolBuiltinAutoHandlerEntriesWithNative: listBuiltinAutoHandlerEntriesMock,
    planServertoolRegistryLookupFromSkeletonWithNative: planServertoolRegistryLookupFromSkeletonWithNativeMock,
    resolveServertoolBuiltinHandlerEntryWithNative: getBuiltinHandlerEntryMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistryBuiltinAutoHookEntriesWithNative:
      planServertoolRegistryBuiltinAutoHookEntriesWithNativeMock,
  })
);

const {
  getServerToolHandler,
  listAutoServerToolHooks,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js'
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
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('function resolveBuiltinEntry(');
    expect(source).not.toContain('.trim().toLowerCase()');
    expect(source).not.toContain("if (actionPlan.action === 'return_builtin')");
    expect(source).toContain('switch (actionPlan.action)');
    expect(source).toContain("case 'return_none':");
    expect(source).toContain('invalid registry lookup action');
    expect(source).toContain("planServertoolRegistryLookupFromSkeletonWithNative({");
    expect(source).toContain('planServertoolRegistryBuiltinAutoHookEntriesWithNative({');
    expect(source).not.toContain("from './registry-projection-shell.js'");
    expect(source).not.toContain('getServerToolHandlerViaNativePlan');
  });

  test('keeps native builtin lookup contract errors out of the TS shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('native registry lookup returned builtin without canonicalName');
    expect(source).not.toContain('if (!actionPlan.canonicalName)');
    expect(source).not.toContain('actionPlan.canonicalName as string');
    expect(source).toContain('name: actionPlan.canonicalName');
  });

  test('does not keep a registered-name wrapper around skeleton config', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('export function isRegisteredServerToolName(');
    expect(source).not.toContain('resolveServertoolRegisteredNameWithNative');
    expect(source).not.toContain('isRegisteredServerToolNameViaNativeConfig');
    expect(source).not.toContain('isServertoolRegisteredNameByConfig');
  });

  test('does not rematch native auto-hook descriptors by sourceIndex in TS', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('descriptor.sourceIndex');
    expect(source).not.toContain('native registry auto-hook descriptor missing entry');
    expect(source).toContain('planServertoolRegistryBuiltinAutoHookEntriesWithNative({');
    expect(source).not.toContain('registration: entry.registration as unknown as Record<string, unknown>');
    expect(source).not.toContain('execution: entry.execution as Record<string, unknown>');
  });
});
