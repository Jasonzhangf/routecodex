import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    resolveServertoolRegistryHandlerWithNative: jest.fn(() => ({
      name: 'reasoningStop',
      trigger: 'tool_call',
      registration: {
        name: 'reasoningStop',
        trigger: 'tool_call',
        executionMode: 'guarded'
      }
    })),
    resolveServertoolBuiltinHandlerEntryWithNative: jest.fn(() => ({
      name: 'reasoningStop',
      trigger: 'tool_call',
      registration: {
        name: 'reasoningStop',
        trigger: 'tool_call',
        executionMode: 'guarded'
      }
    })),
    planServertoolBuiltinHandlerNamesWithNative: jest.fn(() => ({ names: ['reasoningStop'] })),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => ({ entries: [] })),
    planServertoolBuiltinHandlerRecordEntriesWithNative: jest.fn(() => ({ entries: [] })),
    planServertoolRegistryBuiltinAutoHookEntriesWithNative: jest.fn(() => []),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(() => ({
      action: 'return_builtin',
      canonicalName: 'reasoningStop'
    })),
  })
);

const {
  getServerToolHandler
} = await import('../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js');

describe('servertool registry casing', () => {
  test('camelCase builtin reasoningStop resolves to a concrete tool_call handler', () => {
    expect(getServerToolHandler('reasoningStop')).toMatchObject({
      name: 'reasoningStop',
      trigger: 'tool_call',
      registration: {
        name: 'reasoningStop',
        trigger: 'tool_call',
        executionMode: 'guarded'
      }
    });
  });
});
