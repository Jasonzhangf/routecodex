import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolRegistryProjectionWithNativeMock = jest.fn();
const planServertoolRegistryAutoHookDescriptorsWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistryProjectionWithNative: planServertoolRegistryProjectionWithNativeMock,
    planServertoolRegistryAutoHookDescriptorsWithNative:
      planServertoolRegistryAutoHookDescriptorsWithNativeMock,
  })
);

const {
  projectAutoServerToolHandlers,
  projectAutoServerToolHookDescriptors,
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
    const alpha = { name: 'alpha', trigger: 'auto', registration: {}, handler: jest.fn() } as any;
    const beta = { name: 'beta', trigger: 'auto', registration: {}, handler: jest.fn() } as any;
    planServertoolRegistryProjectionWithNativeMock.mockReturnValue({
      registeredNames: [],
      registeredRecords: [],
      autoHandlerNames: ['beta', 'alpha'],
    });

    expect(projectAutoServerToolHandlers({ entries: [alpha, beta] })).toEqual([beta, alpha]);
  });

  test('throws when native auto handler projection references a missing entry', () => {
    const alpha = { name: 'alpha', trigger: 'auto', registration: {}, handler: jest.fn() } as any;
    planServertoolRegistryProjectionWithNativeMock.mockReturnValue({
      registeredNames: [],
      registeredRecords: [],
      autoHandlerNames: ['missing'],
    });

    expect(() => projectAutoServerToolHandlers({ entries: [alpha] })).toThrow(
      'native registry auto handler order missing entry'
    );
  });

  test('projects auto-hook descriptors and maps back registration plus handler', () => {
    const handler = jest.fn();
    const entry = {
      name: 'alpha',
      trigger: 'auto',
      registration: { name: 'alpha', trigger: 'auto' },
      handler,
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
        handler,
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
});
