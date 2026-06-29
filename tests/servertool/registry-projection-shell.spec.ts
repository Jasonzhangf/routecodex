import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolRegistryAutoHookDescriptorsWithNativeMock = jest.fn();
const planServertoolRegistrySourceProjectionWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistrySourceProjectionWithNative:
      planServertoolRegistrySourceProjectionWithNativeMock,
    planServertoolRegistryAutoHookDescriptorsWithNative:
      planServertoolRegistryAutoHookDescriptorsWithNativeMock,
  })
);

const {
  projectAutoServerToolHookDescriptors,
  projectRegistrySources,
} = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-projection-shell.js'
);

describe('registry-projection-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  test('projects source-aware registry plan through native source refs', () => {
    const builtinAuto = {
      name: 'stop_message_auto',
      trigger: 'auto',
      registration: { name: 'stop_message_auto', trigger: 'auto' },
      execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
      autoHook: { id: 'stop_message_auto', phase: 'default', priority: 100, order: 0 },
    } as any;
    const builtinRecord = {
      name: 'stop_message_auto',
      trigger: 'auto',
      registration: { name: 'stop_message_auto', trigger: 'auto' },
      execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
    } as any;

    planServertoolRegistrySourceProjectionWithNativeMock.mockReturnValue({
      registeredNames: ['stop_message_auto'],
      autoHandlerRefs: [
        { name: 'stop_message_auto', source: 'builtin', sourceIndex: 0 },
      ],
      registeredRecordRefs: [
        { name: 'stop_message_auto', trigger: 'auto', source: 'builtin', sourceIndex: 0 },
      ],
    });

    expect(projectRegistrySources({
      builtinNames: ['stop_message_auto'],
      builtinAutoHandlerEntries: [builtinAuto],
      builtinRecordEntries: [builtinRecord],
    })).toEqual({
      registeredNames: ['stop_message_auto'],
      autoHandlers: [builtinAuto],
      registeredRecords: [
        { registration: builtinRecord.registration, handler: undefined },
      ],
    });
    expect(planServertoolRegistrySourceProjectionWithNativeMock).toHaveBeenCalledWith({
      builtinNames: ['stop_message_auto'],
      builtinAutoHandlerNames: ['stop_message_auto'],
      builtinRecords: [{ name: 'stop_message_auto', trigger: 'auto' }],
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
      builtinAutoHandlerEntries: [builtinAuto],
      builtinRecordEntries: [],
    })).toThrow('native registry source projection mismatch for auto handler');
  });
});
