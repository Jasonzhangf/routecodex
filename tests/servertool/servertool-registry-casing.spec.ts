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
    materializeServertoolPlannedResultWithNative: jest.fn(),
    createServertoolProviderProtocolErrorFromPlanWithNative: jest.fn(),
    planServertoolTimeoutWatcherWithNative: jest.fn(() => ({ armed: false, timeoutMs: 0 })),
    planServertoolNoopOutcomeWithNative: jest.fn(),
    buildServertoolHandlerErrorToolOutputPayloadWithNative: jest.fn(),
    planServertoolToolCallDispatchWithNative: jest.fn(),
    planServertoolExecutionDispatchErrorWithNative: jest.fn(),
    appendServertoolExecutedRecordWithNative: jest.fn(),
    createServertoolExecutionLoopStateWithNative: jest.fn(),
    planServertoolHandlerErrorExecutionLoopEffectWithNative: jest.fn(),
    planServertoolNoopExecutionLoopEffectWithNative: jest.fn(),
    resolveServertoolExecutionLoopInitialDecisionWithNative: jest.fn(),
    resolveServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopInitialDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(() => ({
      action: 'return_builtin',
      canonicalName: 'reasoningStop'
    })),
  })
);

const {
  getServerToolHandler
} = await import('../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js');

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
