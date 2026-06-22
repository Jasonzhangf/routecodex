import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolRegistryRegistrationActionWithNativeMock = jest.fn();
const planServertoolRegistryLookupActionWithNativeMock = jest.fn();
const getBuiltinHandlerEntryMock = jest.fn();
const listBuiltinHandlerNamesMock = jest.fn();
const getAdHocHandlerEntryMock = jest.fn();
const registerAdHocHandlerForTestsMock = jest.fn();
const getServertoolToolSpecMock = jest.fn();
const isServertoolEnabledByConfigMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistryRegistrationActionWithNative:
      planServertoolRegistryRegistrationActionWithNativeMock,
    planServertoolRegistryLookupActionWithNative: planServertoolRegistryLookupActionWithNativeMock,
  })
);

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
    getServertoolToolSpec: getServertoolToolSpecMock,
    isServertoolEnabledByConfig: isServertoolEnabledByConfigMock,
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
    isServertoolEnabledByConfigMock.mockReturnValue(true);
  });

  test('registers ad-hoc handler only when native registration plan allows it', () => {
    const handler = jest.fn();
    planServertoolRegistryRegistrationActionWithNativeMock.mockReturnValue({
      action: 'register_adhoc',
    });

    registerServerToolHandlerViaNativePlan(' Custom ', handler, { trigger: 'tool_call' });

    expect(planServertoolRegistryRegistrationActionWithNativeMock).toHaveBeenCalledWith({
      name: ' Custom ',
      hasHandler: true,
      builtinNameMatched: false,
      builtinEntryPresent: false,
      registrationAllowedByConfig: true,
    });
    expect(registerAdHocHandlerForTestsMock).toHaveBeenCalledWith(
      ' Custom ',
      handler,
      { trigger: 'tool_call' }
    );
  });

  test('does not register when native registration plan rejects the request', () => {
    planServertoolRegistryRegistrationActionWithNativeMock.mockReturnValue({
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

    planServertoolRegistryLookupActionWithNativeMock.mockReturnValueOnce({
      action: 'return_builtin',
    });
    expect(getServerToolHandlerViaNativePlan('Builtin')).toBe(builtin);

    planServertoolRegistryLookupActionWithNativeMock.mockReturnValueOnce({
      action: 'return_adhoc',
    });
    expect(getServerToolHandlerViaNativePlan('adhoc')).toBe(adhoc);

    planServertoolRegistryLookupActionWithNativeMock.mockReturnValueOnce({
      action: 'return_none',
    });
    expect(getServerToolHandlerViaNativePlan('missing')).toBeUndefined();
  });

  test('checks registered tool names through native skeleton config', () => {
    getServertoolToolSpecMock.mockReturnValueOnce({ enabled: true });
    expect(isRegisteredServerToolNameViaNativeConfig('alpha')).toBe(true);

    getServertoolToolSpecMock.mockReturnValueOnce({ enabled: false });
    expect(isRegisteredServerToolNameViaNativeConfig('beta')).toBe(false);

    getServertoolToolSpecMock.mockReturnValueOnce(null);
    expect(isRegisteredServerToolNameViaNativeConfig('missing')).toBe(false);
  });
});
