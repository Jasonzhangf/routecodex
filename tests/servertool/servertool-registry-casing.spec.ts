import { describe, expect, jest, test } from '@jest/globals';

const resolveServertoolRegistryHandlerWithNativeMock = jest.fn(() => ({
  name: 'reasoningStop',
  trigger: 'tool_call',
  registration: {
    name: 'reasoningStop',
    trigger: 'tool_call',
    executionMode: 'guarded'
  }
}));
const createServertoolExecutionLoopStateWithNativeMock = jest.fn(() => ({
  executedToolCalls: [],
  executedIds: [],
  executedFlowIds: []
}));
const resolveServertoolExecutionLoopInitialDecisionWithNativeMock = jest.fn(() => ({
  action: 'skip_non_tool_call_handler'
}));
const applyServertoolExecutionLoopInitialDecisionWithNativeMock = jest.fn((decision: any, application: any) => {
  if (decision?.action === 'skip_non_tool_call_handler') {
    return application.skipNonToolCallHandler();
  }
  throw new Error('[servertool] unexpected registry casing test action');
});

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    resolveServertoolRegistryHandlerWithNative: resolveServertoolRegistryHandlerWithNativeMock,
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
    createServertoolExecutionLoopStateWithNative: createServertoolExecutionLoopStateWithNativeMock,
    planServertoolHandlerErrorExecutionLoopEffectWithNative: jest.fn(),
    planServertoolNoopExecutionLoopEffectWithNative: jest.fn(),
    resolveServertoolExecutionLoopInitialDecisionWithNative:
      resolveServertoolExecutionLoopInitialDecisionWithNativeMock,
    resolveServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopInitialDecisionWithNative:
      applyServertoolExecutionLoopInitialDecisionWithNativeMock,
    applyServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(() => ({
      action: 'return_builtin',
      canonicalName: 'reasoningStop'
    })),
  })
);

const {
  runServertoolIoExecutionQueue
} = await import('../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js');

describe('servertool registry casing', () => {
  test('camelCase builtin reasoningStop resolves through queue registry lookup', async () => {
    await runServertoolIoExecutionQueue({
      dispatchPlan: {
        executableToolCalls: [
          {
            id: 'call-reasoning-stop',
            name: 'reasoningStop',
            arguments: '{}',
            executionMode: 'guarded',
            stripAfterExecute: false
          }
        ],
        noopToolCalls: []
      } as any,
      options: { requestId: 'req-reasoning-stop' } as any,
      contextBase: {
        base: {},
        toolCalls: [],
        adapterContext: {},
        requestId: 'req-reasoning-stop',
        entryEndpoint: 'openai',
        providerProtocol: 'openai-chat'
      } as any,
      baseForExecution: {} as any
    });
    expect(resolveServertoolRegistryHandlerWithNativeMock).toHaveBeenCalledWith({
      name: 'reasoningStop'
    });
    expect(resolveServertoolExecutionLoopInitialDecisionWithNativeMock).toHaveBeenCalledWith({
      hasHandlerEntry: true,
      triggerMode: 'tool_call',
      nativeExecutionMode: 'guarded',
      tsExecutionMode: 'guarded'
    });
  });
});
