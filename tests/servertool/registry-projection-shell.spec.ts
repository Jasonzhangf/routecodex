import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolRegistryProjectionWithNativeMock = jest.fn();
const planServertoolRegistryAutoHookDescriptorsWithNativeMock = jest.fn();
const planServertoolRegistrySourceProjectionWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistryProjectionWithNative: planServertoolRegistryProjectionWithNativeMock,
    planServertoolRegistrySourceProjectionWithNative:
      planServertoolRegistrySourceProjectionWithNativeMock,
    planServertoolRegistryAutoHookDescriptorsWithNative:
      planServertoolRegistryAutoHookDescriptorsWithNativeMock,
  })
);

const {
  projectAutoServerToolHandlers,
  projectAutoServerToolHookDescriptors,
  projectRegistrySources,
  projectRegisteredServerToolHandlerRecords,
  projectRegistryHandlerNames,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-projection-shell.js'
);

describe('registry-projection-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('projects registered handler names through native registry projection', () => {
    planServertoolRegistryProjectionWithNativeMock.mockReturnValue({
      registeredNames: ['alpha', 'beta'],
      registeredRecords: [],
      autoHandlerNames: [],
    });

    expect(projectRegistryHandlerNames({ names: [' beta ', 'alpha'] })).toEqual(['alpha', 'beta']);
    expect(planServertoolRegistryProjectionWithNativeMock).toHaveBeenCalledWith({
      registeredNames: [' beta ', 'alpha'],
      registeredRecords: [],
      autoHandlerNames: [],
    });
  });

  test('projects auto handler order and maps back to entries', () => {
    const alpha = {
      name: 'alpha',
      trigger: 'auto',
      registration: {},
      execution: { kind: 'builtin', builtinName: 'alpha' }
    } as any;
    const beta = {
      name: 'beta',
      trigger: 'auto',
      registration: {},
      execution: { kind: 'builtin', builtinName: 'beta' }
    } as any;
    planServertoolRegistryProjectionWithNativeMock.mockReturnValue({
      registeredNames: [],
      registeredRecords: [],
      autoHandlerNames: ['beta', 'alpha'],
    });

    expect(projectAutoServerToolHandlers({ entries: [alpha, beta] })).toEqual([beta, alpha]);
  });

  test('throws when native auto handler projection references a missing entry', () => {
    const alpha = {
      name: 'alpha',
      trigger: 'auto',
      registration: {},
      execution: { kind: 'builtin', builtinName: 'alpha' }
    } as any;
    planServertoolRegistryProjectionWithNativeMock.mockReturnValue({
      registeredNames: [],
      registeredRecords: [],
      autoHandlerNames: ['missing'],
    });

    expect(() => projectAutoServerToolHandlers({ entries: [alpha] })).toThrow(
      'native registry auto handler order missing entry'
    );
  });

  test('projects auto-hook descriptors and maps back registration plus execution', () => {
    const execution = { kind: 'builtin', builtinName: 'alpha' };
    const entry = {
      name: 'alpha',
      trigger: 'auto',
      registration: { name: 'alpha', trigger: 'auto' },
      execution,
      autoHook: { phase: 'post', priority: 9, order: 1 },
    } as any;
    planServertoolRegistryAutoHookDescriptorsWithNativeMock.mockReturnValue([
      { id: 'alpha', phase: 'post', priority: 9, order: 1 },
    ]);

    expect(projectAutoServerToolHookDescriptors({ entries: [entry] })).toEqual([
      {
        id: 'alpha',
        phase: 'post',
        priority: 9,
        order: 1,
        registration: entry.registration,
        execution,
      },
    ]);
  });

  test('projects registered records and rejects projection mismatch', () => {
    const handler = jest.fn();
    const rawRecords = [
      {
        name: 'alpha',
        trigger: 'tool_call',
        registration: { name: 'alpha', trigger: 'tool_call' },
        handler,
      },
    ] as any;
    planServertoolRegistryProjectionWithNativeMock.mockReturnValue({
      registeredNames: [],
      registeredRecords: [{ name: 'alpha', trigger: 'tool_call', sourceIndex: 0 }],
      autoHandlerNames: [],
    });

    expect(projectRegisteredServerToolHandlerRecords({ rawRecords })).toEqual([
      { registration: rawRecords[0].registration, handler },
    ]);

    planServertoolRegistryProjectionWithNativeMock.mockReturnValue({
      registeredNames: [],
      registeredRecords: [{ name: 'beta', trigger: 'tool_call', sourceIndex: 0 }],
      autoHandlerNames: [],
    });
    expect(() => projectRegisteredServerToolHandlerRecords({ rawRecords })).toThrow(
      'native registry record projection mismatch'
    );
  });

  test('projects source-aware registry plan through native source refs', () => {
    const builtinAuto = {
      name: 'stop_message_auto',
      trigger: 'auto',
      registration: { name: 'stop_message_auto', trigger: 'auto' },
      execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
      autoHook: { id: 'stop_message_auto', phase: 'default', priority: 100, order: 0 },
    } as any;
    const adHocAuto = {
      name: 'custom_auto',
      trigger: 'auto',
      registration: { name: 'custom_auto', trigger: 'auto' },
      execution: { kind: 'adhoc', handler: jest.fn() },
      autoHook: { id: 'custom_auto', phase: 'default', priority: 100, order: 1 },
    } as any;
    const builtinRecord = {
      name: 'stop_message_auto',
      trigger: 'auto',
      registration: { name: 'stop_message_auto', trigger: 'auto' },
      execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
    } as any;
    const adHocHandler = jest.fn();
    const adHocRecord = {
      registration: { name: 'custom_tool', trigger: 'tool_call' },
      handler: adHocHandler,
    } as any;

    planServertoolRegistrySourceProjectionWithNativeMock.mockReturnValue({
      registeredNames: ['custom_tool', 'stop_message_auto'],
      autoHandlerRefs: [
        { name: 'custom_auto', source: 'adhoc', sourceIndex: 0 },
        { name: 'stop_message_auto', source: 'builtin', sourceIndex: 0 },
      ],
      registeredRecordRefs: [
        { name: 'custom_tool', trigger: 'tool_call', source: 'adhoc', sourceIndex: 0 },
        { name: 'stop_message_auto', trigger: 'auto', source: 'builtin', sourceIndex: 0 },
      ],
    });

    expect(projectRegistrySources({
      builtinNames: ['stop_message_auto'],
      adHocNames: ['custom_tool'],
      builtinAutoHandlerEntries: [builtinAuto],
      adHocAutoHandlerEntries: [adHocAuto],
      builtinRecordEntries: [builtinRecord],
      adHocHandlerRecords: [adHocRecord],
    })).toEqual({
      registeredNames: ['custom_tool', 'stop_message_auto'],
      autoHandlers: [adHocAuto, builtinAuto],
      registeredRecords: [
        { registration: adHocRecord.registration, handler: adHocHandler },
        { registration: builtinRecord.registration, handler: undefined },
      ],
    });
    expect(planServertoolRegistrySourceProjectionWithNativeMock).toHaveBeenCalledWith({
      builtinNames: ['stop_message_auto'],
      adHocNames: ['custom_tool'],
      builtinAutoHandlerNames: ['stop_message_auto'],
      adHocAutoHandlerNames: ['custom_auto'],
      builtinRecords: [{ name: 'stop_message_auto', trigger: 'auto' }],
      adHocRecords: [{ name: 'custom_tool', trigger: 'tool_call' }],
    });
  });

  test('rejects source projection mismatches', () => {
    const builtinAuto = {
      name: 'stop_message_auto',
      trigger: 'auto',
      registration: { name: 'stop_message_auto', trigger: 'auto' },
      execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
    } as any;

    planServertoolRegistrySourceProjectionWithNativeMock.mockReturnValue({
      registeredNames: [],
      autoHandlerRefs: [{ name: 'wrong', source: 'builtin', sourceIndex: 0 }],
      registeredRecordRefs: [],
    });

    expect(() => projectRegistrySources({
      builtinNames: ['stop_message_auto'],
      adHocNames: [],
      builtinAutoHandlerEntries: [builtinAuto],
      adHocAutoHandlerEntries: [],
      builtinRecordEntries: [],
      adHocHandlerRecords: [],
    })).toThrow('native registry source projection mismatch for auto handler');
  });
});
