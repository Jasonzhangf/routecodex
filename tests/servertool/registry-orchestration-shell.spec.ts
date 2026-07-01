import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinAutoHandlerEntriesMock = jest.fn();
const planServertoolRegistryLookupFromSkeletonWithNativeMock = jest.fn();
const planServertoolRegistryAutoHookDescriptorsWithNativeMock = jest.fn();

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
    planServertoolRegistryAutoHookDescriptorsWithNative:
      planServertoolRegistryAutoHookDescriptorsWithNativeMock,
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
    planServertoolRegistryAutoHookDescriptorsWithNativeMock.mockReturnValue([
      { id: 'alpha', phase: 'post', priority: 9, order: 1, sourceIndex: 0 },
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
    expect(planServertoolRegistryAutoHookDescriptorsWithNativeMock).toHaveBeenCalledWith({
      hooks: [{ id: 'alpha', phase: 'post', priority: 9, order: 1 }],
    });
  });

  test('rejects missing auto-hook descriptor indexes without rematching names in TS', () => {
    listBuiltinAutoHandlerEntriesMock.mockReturnValue({ entries: [] });
    planServertoolRegistryAutoHookDescriptorsWithNativeMock.mockReturnValue([
      { id: 'wrong', phase: 'post', priority: 9, order: 1, sourceIndex: 1 },
    ]);

    expect(() => listAutoServerToolHooks()).toThrow(
      'native registry auto-hook descriptor missing entry'
    );
  });

  test('registry orchestration shell owns builtin lookup but not name normalization', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('function resolveBuiltinEntry(');
    expect(source).not.toContain('.trim().toLowerCase()');
    expect(source).toContain("planServertoolRegistryLookupFromSkeletonWithNative({");
    expect(source).toContain('planServertoolRegistryAutoHookDescriptorsWithNative({');
    expect(source).not.toContain("from './registry-projection-shell.js'");
    expect(source).not.toContain('getServerToolHandlerViaNativePlan');
  });

  test('keeps native builtin lookup contract errors out of the TS shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('native registry lookup returned builtin without canonicalName');
    expect(source).not.toContain('if (!actionPlan.canonicalName)');
    expect(source).toContain('name: actionPlan.canonicalName as string');
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
});
