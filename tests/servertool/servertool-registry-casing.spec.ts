import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js',
  () => ({
    isServertoolRegisteredNameByConfig: jest.fn((name: string) => name === 'reasoningStop'),
    normalizeServerToolRegistrationSpec: jest.fn((name: string, options?: { trigger?: string }) => ({
      name,
      trigger: options?.trigger ?? 'tool_call',
      executionMode: 'guarded',
      stripAfterExecute: true
    })),
    resolveServertoolBuiltinHandlerEntry: jest.fn(() => ({
      name: 'reasoningStop',
      trigger: 'tool_call',
      registration: {
        name: 'reasoningStop',
        trigger: 'tool_call',
        executionMode: 'guarded'
      }
    })),
    planServertoolBuiltinHandlerNames: jest.fn(() => ['reasoningStop']),
    planServertoolBuiltinAutoHandlerEntries: jest.fn(() => []),
    planServertoolBuiltinHandlerRecordEntries: jest.fn(() => [])
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
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
