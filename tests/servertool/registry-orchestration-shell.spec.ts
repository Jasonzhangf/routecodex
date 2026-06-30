import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinAutoHandlerEntriesMock = jest.fn();
const listBuiltinHandlerRecordEntriesMock = jest.fn();
const listBuiltinHandlerNamesMock = jest.fn();
const planServertoolRegistryLookupFromSkeletonWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.js',
  () => ({
    getBuiltinHandlerEntry: getBuiltinHandlerEntryMock,
    listBuiltinAutoHandlerEntries: listBuiltinAutoHandlerEntriesMock,
    listBuiltinHandlerRecordEntries: listBuiltinHandlerRecordEntriesMock,
    listBuiltinHandlerNames: listBuiltinHandlerNamesMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolRegistryLookupFromSkeletonWithNative: planServertoolRegistryLookupFromSkeletonWithNativeMock,
    resolveServertoolRegisteredNameWithNative: jest.fn(() => false),
  })
);

const {
  getServerToolHandler,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js'
);

describe('registry-orchestration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBuiltinAutoHandlerEntriesMock.mockReturnValue([]);
    listBuiltinHandlerRecordEntriesMock.mockReturnValue([]);
    listBuiltinHandlerNamesMock.mockReturnValue([]);
  });

  test('returns builtin entry and ignores retired ad-hoc lookup plans', () => {
    const builtin = { name: 'builtin' };
    listBuiltinHandlerNamesMock.mockReturnValue(['builtin']);
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

  test('registry orchestration shell owns builtin lookup but not name normalization', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('function resolveBuiltinEntry(');
    expect(source).not.toContain('.trim().toLowerCase()');
    expect(source).toContain("planServertoolRegistryLookupFromSkeletonWithNative({");
    expect(source).not.toContain('getServerToolHandlerViaNativePlan');
  });

  test('fails fast when native builtin lookup omits canonicalName', () => {
    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'return_builtin',
    });

    expect(() => getServerToolHandler('Builtin')).toThrow(
      'native registry lookup returned builtin without canonicalName'
    );
  });

  test('does not keep a registered-name wrapper around skeleton config', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('isRegisteredServerToolNameViaNativeConfig');
    expect(source).not.toContain('isServertoolRegisteredNameByConfig');
  });
});
