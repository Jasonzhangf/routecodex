import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js',
  () => ({})
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    resolveServertoolRegisteredNameWithNative: jest.fn((input: { name: string }) => input.name === 'reasoningStop'),
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
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(() => ({
      action: 'return_builtin',
      canonicalName: 'reasoningStop'
    })),
  })
);

const {
  getServerToolHandler,
  isRegisteredServerToolName
} = await import('../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js');

describe('servertool registry casing', () => {
  test('camelCase builtin reasoningStop resolves to a concrete tool_call handler', () => {
    expect(isRegisteredServerToolName('reasoningStop')).toBe(true);
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
