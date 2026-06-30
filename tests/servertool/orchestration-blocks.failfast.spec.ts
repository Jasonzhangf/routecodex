import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runServertoolOrchestrationMutationWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolSkeletonDerivedConfigWithNative: jest.fn(() => ({
      autoHookQueueConfig: {
        optionalPrimaryOrder: [],
        mandatoryOrder: []
      }
    })),
    planServertoolAutoHookQueuesWithNative: jest.fn(() => ({
      optionalQueue: [],
      mandatoryQueue: []
    })),
    runServertoolOrchestrationMutationWithNative
  })
);

const { buildToolMessagesFromOutputs } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.js'
);

describe('orchestration-blocks native array boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fails fast instead of filtering invalid native array entries', () => {
    runServertoolOrchestrationMutationWithNative.mockReturnValue([
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      'invalid-tool-message'
    ]);

    expect(() => buildToolMessagesFromOutputs({ tool_outputs: [] } as any, new Set(['call_1']))).toThrow(
      '[servertool] orchestration mutation returned invalid array entry at index 1'
    );
  });
});
