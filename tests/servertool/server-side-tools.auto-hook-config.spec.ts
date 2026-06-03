import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const skeletonDocument = {
  servertool: {
    skeleton: {
      autoHooks: {
        optionalPrimaryOrder: ['stop_message_auto'],
        mandatoryOrder: []
      },
      pendingInjection: {
        messageKinds: ['assistant_tool_calls', 'tool_outputs']
      },
      progress: {
        toolNameByFlowId: {},
        goldHighlightFlowIds: []
      },
      followup: {
        genericInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs'],
        nativeSupportedOps: [],
        flowPolicy: {
          profilesByFlowId: {
            stop_message_flow: {
              seedLoopPayload: true,
              retryEmptyFollowupOnce: true,
              stopMessageFollowupPolicy: 'preserve_eligibility'
            }
          }
        }
      }
    },
    state: {
      scopePriority: [],
      pendingInjection: { enabled: true, strictContract: true }
    },
    internalTools: {
      stop_message_auto: {
        name: 'stop_message_auto',
        enabled: true,
        trigger: { type: 'auto', canonicalName: 'stop_message_auto', phase: 'default', priority: 40 },
        execution: { mode: 'auto_hook', stripAfterExecute: true }
      }
    }
  }
};

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    getDefaultServertoolSkeletonDocumentWithNative: jest.fn(() => skeletonDocument),
    planServertoolAutoHookQueuesWithNative: jest.fn((input: any) => ({
      optionalQueue: [...input.hooks].sort((a, b) => a.priority - b.priority),
      mandatoryQueue: []
    }))
  })
);

let buildServertoolAutoHookQueueConfig: any;
let buildServertoolFollowupConfig: any;
let buildServertoolPendingInjectionConfig: any;
let getDefaultServertoolSkeletonDocument: any;
let getServertoolToolSpec: any;
let normalizeServerToolRegistrationSpec: any;

beforeAll(async () => {
  const skeletonConfig = await import('../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js');
  buildServertoolAutoHookQueueConfig = skeletonConfig.buildServertoolAutoHookQueueConfig;
  buildServertoolFollowupConfig = skeletonConfig.buildServertoolFollowupConfig;
  buildServertoolPendingInjectionConfig = skeletonConfig.buildServertoolPendingInjectionConfig;
  getDefaultServertoolSkeletonDocument = skeletonConfig.getDefaultServertoolSkeletonDocument;
  getServertoolToolSpec = skeletonConfig.getServertoolToolSpec;
  normalizeServerToolRegistrationSpec = skeletonConfig.normalizeServerToolRegistrationSpec;

});

describe('servertool skeleton config', () => {
  test('exposes declarative auto hook queue order from skeleton config', () => {
    const skeleton = getDefaultServertoolSkeletonDocument();
    expect(skeleton.servertool.skeleton.autoHooks.optionalPrimaryOrder).toEqual([
      'stop_message_auto'
    ]);
    expect(buildServertoolAutoHookQueueConfig()).toEqual({
      optionalPrimaryOrder: ['empty_reply_continue', 'stop_message_auto'],
      mandatoryOrder: []
    });
    expect(buildServertoolPendingInjectionConfig()).toEqual({
      messageKinds: ['assistant_tool_calls', 'tool_outputs']
    });
    const followup = buildServertoolFollowupConfig();
    expect(followup.genericInjectionOps).toEqual([
      'append_assistant_message',
      'append_tool_messages_from_tool_outputs'
    ]);
    expect(followup.flowPolicy.profilesByFlowId.stop_message_flow).toMatchObject({
      seedLoopPayload: true,
      retryEmptyFollowupOnce: true,
      stopMessageFollowupPolicy: 'preserve_eligibility'
    });
  });

  test('normalizes registration spec from config truth', () => {
    const spec = normalizeServerToolRegistrationSpec('reasoning_stop', {
      trigger: 'tool_call'
    });
    expect(spec).toMatchObject({
      name: 'reasoning_stop',
      enabled: true,
      trigger: 'tool_call',
      executionMode: 'guarded',
      stripAfterExecute: true
    });
  });

  test('per-tool spec is the authoritative source for trigger and mode', () => {
    const stopMessage = getServertoolToolSpec('stop_message_auto');
    expect(stopMessage).toMatchObject({
      name: 'stop_message_auto',
      trigger: {
        type: 'auto',
        canonicalName: 'stop_message_auto',
        phase: 'default',
        priority: 40
      },
      execution: {
        mode: 'auto_hook',
        stripAfterExecute: true
      }
    });
    expect(getServertoolToolSpec('reasoning_stop')).toBeNull();
  });

});
