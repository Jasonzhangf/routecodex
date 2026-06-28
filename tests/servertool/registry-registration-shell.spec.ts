import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinHandlerNamesMock = jest.fn();
const getAdHocHandlerEntryMock = jest.fn();
const registerAdHocHandlerForTestsMock = jest.fn();
const planServertoolRegistryRegistrationFromSkeletonMock = jest.fn();
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
  '../../sharedmodule/llmswitch-core/src/servertool/adhoc-handler-test-support.js',
  () => ({
    getAdHocHandlerEntry: getAdHocHandlerEntryMock,
    registerAdHocHandlerForTests: registerAdHocHandlerForTestsMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js',
  () => ({
    isServertoolRegisteredNameByConfig: isServertoolRegisteredNameByConfigMock,
    planServertoolRegistryLookupFromSkeleton: planServertoolRegistryLookupFromSkeletonMock,
    planServertoolRegistryRegistrationFromSkeleton:
      planServertoolRegistryRegistrationFromSkeletonMock,
  })
);

const {
  getServerToolHandlerViaNativePlan,
  isRegisteredServerToolNameViaNativeConfig,
  registerServerToolHandlerViaNativePlan,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.js'
);

describe('registry-registration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBuiltinHandlerNamesMock.mockReturnValue([]);
    isServertoolRegisteredNameByConfigMock.mockReturnValue(true);
  });

  test('registers ad-hoc handler only when native registration plan allows it', () => {
    const handler = jest.fn();
    planServertoolRegistryRegistrationFromSkeletonMock.mockReturnValue({
      action: 'register_adhoc',
    });

    registerServerToolHandlerViaNativePlan(' Custom ', handler, { trigger: 'tool_call' });

    expect(planServertoolRegistryRegistrationFromSkeletonMock).toHaveBeenCalledWith({
      name: ' Custom ',
      hasHandler: true,
    });
    expect(registerAdHocHandlerForTestsMock).toHaveBeenCalledWith(
      ' Custom ',
      handler,
      { trigger: 'tool_call' }
    );
  });

  test('does not register when native registration plan rejects the request', () => {
    planServertoolRegistryRegistrationFromSkeletonMock.mockReturnValue({
      action: 'ignore',
    });

    registerServerToolHandlerViaNativePlan('custom', jest.fn());

    expect(registerAdHocHandlerForTestsMock).not.toHaveBeenCalled();
  });

  test('returns builtin or ad-hoc entry based on native lookup plan', () => {
    const builtin = { name: 'builtin' };
    const adhoc = { name: 'adhoc' };
    listBuiltinHandlerNamesMock.mockReturnValue(['builtin']);
    getBuiltinHandlerEntryMock.mockReturnValue(builtin);
    getAdHocHandlerEntryMock.mockReturnValue(adhoc);

    planServertoolRegistryLookupFromSkeletonMock.mockReturnValueOnce({
      action: 'return_builtin',
      canonicalName: 'builtin',
    });
    expect(getServerToolHandlerViaNativePlan('Builtin')).toBe(builtin);

    planServertoolRegistryLookupFromSkeletonMock.mockReturnValueOnce({
      action: 'return_adhoc',
    });
    expect(getServerToolHandlerViaNativePlan('adhoc')).toBe(adhoc);

    planServertoolRegistryLookupFromSkeletonMock.mockReturnValueOnce({
      action: 'return_none',
    });
    expect(getServerToolHandlerViaNativePlan('missing')).toBeUndefined();
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
