import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolRegistryAutoHookDescriptorsWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistryAutoHookDescriptorsWithNative:
      planServertoolRegistryAutoHookDescriptorsWithNativeMock,
  })
);

const {
  projectAutoServerToolHookDescriptors,
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
      { id: 'alpha', phase: 'post', priority: 9, order: 1, sourceIndex: 0 },
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

  test('registry projection shell does not own name normalization', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/registry-projection-shell.ts', 'utf8')
    );

    expect(source).toContain('sourceIndex');
    expect(source).toContain('planServertoolRegistryAutoHookDescriptorsWithNative({');
    expect(source).not.toContain('planServertoolRegistrySourceProjectionWithNative');
    expect(source).not.toContain('projectRegistrySources');
    expect(source).not.toContain('const autoHookDescriptorInput = {');
    expect(source).not.toContain('const registrySourceProjectionInput = {');
    expect(source).not.toContain('function canonicalName(');
    expect(source).not.toContain('.trim().toLowerCase()');
    expect(source).not.toContain('native registry source projection mismatch');
  });
});
