import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinHandlerNamesMock = jest.fn();
const planServertoolRegistryLookupFromSkeletonMock = jest.fn();
const isServertoolRegisteredNameByConfigMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.js',
  () => ({
    getBuiltinHandlerEntry: getBuiltinHandlerEntryMock,
    listBuiltinHandlerNames: listBuiltinHandlerNamesMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js',
  () => ({
    isServertoolRegisteredNameByConfig: isServertoolRegisteredNameByConfigMock,
    planServertoolRegistryLookupFromSkeleton: planServertoolRegistryLookupFromSkeletonMock,
  })
);

const {
  getServerToolHandlerViaNativePlan,
  isRegisteredServerToolNameViaNativeConfig,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.js'
);

describe('registry-registration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBuiltinHandlerNamesMock.mockReturnValue([]);
    isServertoolRegisteredNameByConfigMock.mockReturnValue(true);
  });

  test('returns builtin entry and ignores retired ad-hoc lookup plans', () => {
    const builtin = { name: 'builtin' };
    listBuiltinHandlerNamesMock.mockReturnValue(['builtin']);
    getBuiltinHandlerEntryMock.mockReturnValue(builtin);

    planServertoolRegistryLookupFromSkeletonMock.mockReturnValueOnce({
      action: 'return_builtin',
      canonicalName: 'builtin',
    });
    expect(getServerToolHandlerViaNativePlan('Builtin')).toBe(builtin);

    planServertoolRegistryLookupFromSkeletonMock.mockReturnValueOnce({
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
  });

  test('fails fast when native builtin lookup omits canonicalName', () => {
    planServertoolRegistryLookupFromSkeletonMock.mockReturnValueOnce({
      action: 'return_builtin',
    });

    expect(() => getServerToolHandlerViaNativePlan('Builtin')).toThrow(
      'native registry lookup returned builtin without canonicalName'
    );
  });

  test('checks registered tool names through native skeleton config', () => {
    isServertoolRegisteredNameByConfigMock.mockReturnValueOnce(true);
    expect(isRegisteredServerToolNameViaNativeConfig('alpha')).toBe(true);

    isServertoolRegisteredNameByConfigMock.mockReturnValueOnce(false);
    expect(isRegisteredServerToolNameViaNativeConfig('beta')).toBe(false);

    isServertoolRegisteredNameByConfigMock.mockReturnValueOnce(false);
    expect(isRegisteredServerToolNameViaNativeConfig('missing')).toBe(false);
  });
});
