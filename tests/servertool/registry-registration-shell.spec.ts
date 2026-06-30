import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinHandlerNamesMock = jest.fn();
const planServertoolRegistryLookupFromSkeletonWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.js',
  () => ({
    getBuiltinHandlerEntry: getBuiltinHandlerEntryMock,
    listBuiltinHandlerNames: listBuiltinHandlerNamesMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolRegistryLookupFromSkeletonWithNative: planServertoolRegistryLookupFromSkeletonWithNativeMock,
  })
);

const {
  getServerToolHandlerViaNativePlan,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.js'
);

describe('registry-registration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(getServerToolHandlerViaNativePlan('Builtin')).toBe(builtin);

    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'return_none',
    });
    expect(getServerToolHandlerViaNativePlan('adhoc')).toBeUndefined();
  });

  test('registry registration shell does not own builtin name normalization', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('function resolveBuiltinEntry(');
    expect(source).not.toContain('.trim().toLowerCase()');
    expect(source).toContain("planServertoolRegistryLookupFromSkeletonWithNative({");
    expect(source).not.toContain('const registryLookupInput = {');
  });

  test('fails fast when native builtin lookup omits canonicalName', () => {
    planServertoolRegistryLookupFromSkeletonWithNativeMock.mockReturnValueOnce({
      action: 'return_builtin',
    });

    expect(() => getServerToolHandlerViaNativePlan('Builtin')).toThrow(
      'native registry lookup returned builtin without canonicalName'
    );
  });

  test('does not keep a registered-name wrapper around skeleton config', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.ts', 'utf8')
    );

    expect(source).not.toContain('isRegisteredServerToolNameViaNativeConfig');
    expect(source).not.toContain('isServertoolRegisteredNameByConfig');
  });
});
