import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const skeletonDocument = {
  servertool: {
    skeleton: {
      autoHooks: {
        optionalPrimaryOrder: ['vision_auto', 'stop_message_auto'],
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
              seedLoopPayload: true
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
      vision_auto: {
        name: 'vision_auto',
        enabled: true,
        trigger: { type: 'auto', canonicalName: 'vision_auto', phase: 'default', priority: 20 },
        execution: { mode: 'auto_hook', stripAfterExecute: true }
      },
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
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    getDefaultServertoolSkeletonDocumentWithNative: jest.fn(() => skeletonDocument),
    planServertoolToolCallDispatchWithNative: jest.fn(() => ({
      executableToolCalls: [],
      skippedToolCalls: [],
      noopToolCalls: []
    })),
    planServertoolOutcomeWithNative: jest.fn(() => ({
      outcomeMode: 'servertool_only',
      followupStrategy: 'generic_tool_outputs',
      useGenericFollowup: true,
      useLastExecutionFollowup: false,
      requiresPendingInjection: false,
      pendingInjectionMessagesResolved: [],
      pendingInjectionMessageKinds: [],
      remainingToolCallIds: [],
      aliasSessionIds: [],
      resolvedFollowup: {
        requestIdSuffix: ':servertool_followup',
        injection: {
          ops: [
            { op: 'append_assistant_message', required: true },
            { op: 'append_tool_messages_from_tool_outputs', required: true }
          ]
        }
      }
    })),
    planServertoolNoopOutcomeWithNative: jest.fn((input: any) => ({
      flowId: `${String(input.toolName ?? 'noop')}_noop`,
      followup: {
        requestIdSuffix: ':servertool_followup',
        injection: {
          ops: [
            { op: 'append_assistant_message', required: true },
            { op: 'append_tool_messages_from_tool_outputs', required: true }
          ]
        }
      },
      executionContext: {},
      chatResponse: input.base ?? {}
    })),
    planServertoolSkeletonDerivedConfigWithNative: jest.fn(() => ({
      document: skeletonDocument,
      toolSpecs: skeletonDocument.servertool.internalTools,
      toolSpecList: Object.values(skeletonDocument.servertool.internalTools),
      autoHookQueueConfig: {
        optionalPrimaryOrder: ['vision_auto', 'stop_message_auto'],
        mandatoryOrder: []
      },
      pendingInjectionConfig: {
        messageKinds: ['assistant_tool_calls', 'tool_outputs']
      },
      followupConfig: {
        genericInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs'],
        nativeSupportedOps: [],
        flowPolicy: {
          profilesByFlowId: {
            stop_message_flow: {
              seedLoopPayload: true
            }
          },
          noFollowupFlowIds: [],
          autoLimitFlowIds: [],
          flowOnlyLoopLimitFlowIds: [],
          clientInjectOnlyFlowIds: [],
          seedLoopPayloadFlowIds: [],
          clientInjectSourceByFlowId: {},
          transparentReplayRequestSuffixByFlowId: {},
          ignoreRequiresActionFollowupFlowIds: [],
          contextDecorationModeByFlowId: {}
        }
      },
      stateConfig: {
        scopePriority: [],
        pendingInjection: { enabled: true, strictContract: true }
      }
    })),
    normalizeServertoolRegistrationSpecWithNative: jest.fn((input: any) => {
      const name = String(input.name ?? '').trim().toLowerCase();
      if (!name) {
        return null;
      }
      const toolSpec = (skeletonDocument.servertool.internalTools as Record<string, any>)[name] ?? null;
      const trigger = toolSpec?.trigger?.type ?? input.options?.trigger ?? 'tool_call';
      const executionMode = toolSpec?.execution?.mode ?? input.options?.executionMode ?? 'guarded';
      return {
        name,
        enabled: toolSpec?.enabled ?? true,
        trigger,
        executionMode,
        stripAfterExecute: toolSpec?.execution?.stripAfterExecute ?? true
      };
    }),
    resolveServertoolToolSpecWithNative: jest.fn((input: any) => {
      const name = String(input.name ?? '').trim().toLowerCase();
      return (skeletonDocument.servertool.internalTools as Record<string, any>)[name] ?? null;
    }),
    extractCapturedChatSeedWithNative: jest.fn(() => null),
    normalizeFollowupParametersWithNative: jest.fn((value: any) => value ?? undefined),
    resolveFollowupModelWithNative: jest.fn((seedModel: any) => String(seedModel ?? 'gpt-test')),
    buildServertoolToolOutputPayloadWithNative: jest.fn((payload: any) => payload),
    webSearchIsGeminiEngineWithNative: jest.fn(() => false),
    webSearchIsGlmEngineWithNative: jest.fn(() => false),
    webSearchIsQwenEngineWithNative: jest.fn(() => false),
    webSearchExtractAssistantMessageWithNative: jest.fn(() => 'null'),
    webSearchBuildToolMessagesWithNative: jest.fn(() => '[]'),
    webSearchCollectHitsWithNative: jest.fn(() => '[]'),
    webSearchLimitHitsWithNative: jest.fn(() => '[]'),
    webSearchFormatHitsSummaryWithNative: jest.fn(() => ''),
    webSearchNormalizeResultCountWithNative: jest.fn(() => 5),
    webSearchSanitizeBackendErrorWithNative: jest.fn((message: string) => message),
    webSearchBuildSystemPromptWithNative: jest.fn(() => ''),
    visionBuildAnalysisPayloadWithNative: jest.fn(() => 'null'),
    visionBuildPinnedMetadataWithNative: jest.fn(() => 'null'),
    visionExtractOriginalUserPromptWithNative: jest.fn(() => ''),
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
let registerServerToolHandler: any;
let listAutoServerToolHooks: any;

beforeAll(async () => {
  const skeletonConfig = await import('../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js');
  buildServertoolAutoHookQueueConfig = skeletonConfig.buildServertoolAutoHookQueueConfig;
  buildServertoolFollowupConfig = skeletonConfig.buildServertoolFollowupConfig;
  buildServertoolPendingInjectionConfig = skeletonConfig.buildServertoolPendingInjectionConfig;
  getDefaultServertoolSkeletonDocument = skeletonConfig.getDefaultServertoolSkeletonDocument;
  getServertoolToolSpec = skeletonConfig.getServertoolToolSpec;
  normalizeServerToolRegistrationSpec = skeletonConfig.normalizeServerToolRegistrationSpec;
  const registry = await import('../../sharedmodule/llmswitch-core/src/servertool/registry.js');
  registerServerToolHandler = registry.registerServerToolHandler;
  listAutoServerToolHooks = registry.listAutoServerToolHooks;

});

describe('servertool skeleton config', () => {
  test('exposes declarative auto hook queue order from skeleton config', () => {
    const skeleton = getDefaultServertoolSkeletonDocument();
    expect(skeleton.servertool.skeleton.autoHooks.optionalPrimaryOrder).toEqual([
      'vision_auto',
      'stop_message_auto'
    ]);
    expect(buildServertoolAutoHookQueueConfig()).toEqual({
      optionalPrimaryOrder: ['vision_auto', 'stop_message_auto'],
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
      seedLoopPayload: true
    });
    expect(followup.flowPolicy.profilesByFlowId.stop_message_flow.stopMessageFollowupPolicy).toBeUndefined();
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

  test('registry ignores TS auto-hook overrides for skeleton-owned tools', () => {
    registerServerToolHandler('stop_message_auto', async () => null, {
      trigger: 'tool_call',
      hook: {
        phase: 'post',
        priority: 999
      }
    });

    const hook = listAutoServerToolHooks().find((entry: any) => entry.id === 'stop_message_auto');
    expect(hook).toBeDefined();
    expect(hook).toMatchObject({
      id: 'stop_message_auto',
      phase: 'default',
      priority: 40
    });
    expect(hook.registration).toMatchObject({
      name: 'stop_message_auto',
      trigger: 'auto',
      executionMode: 'auto_hook'
    });
  });

});
