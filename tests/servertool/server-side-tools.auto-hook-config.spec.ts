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

const runServertoolOrchestrationMutationWithNative = jest.fn((input: any) => {
  const op = String(input?.op ?? '').trim();
  if (op === 'build_tool_messages_from_outputs') {
    return [];
  }
  if (op === 'strip_tool_outputs') {
    return input?.base ?? {};
  }
  if (op === 'filter_out_executed_tool_calls') {
    return input?.base ?? {};
  }
  if (op === 'patch_tool_call_arguments_by_id') {
    return input?.base ?? {};
  }
  if (op === 'append_tool_output') {
    return input?.base ?? {};
  }
  if (op === 'build_assistant_tool_call_message') {
    return {
      role: 'assistant',
      tool_calls: Array.isArray(input?.toolCalls) ? input.toolCalls : []
    };
  }
  return input?.base ?? {};
});

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
      const executionMode =
        toolSpec?.execution?.mode ??
        input.options?.executionMode ??
        (trigger === 'auto' ? 'auto_hook' : 'guarded');
      return {
        name,
        enabled: toolSpec?.enabled ?? true,
        trigger,
        executionMode,
        stripAfterExecute: toolSpec?.execution?.stripAfterExecute ?? true,
        ...(trigger === 'auto'
          ? {
              autoHook: {
                id: name,
                phase: toolSpec?.trigger?.phase ?? input.options?.hook?.phase ?? input.options?.phase ?? 'default',
                priority:
                  toolSpec?.trigger?.priority ??
                  input.options?.hook?.priority ??
                  input.options?.priority ??
                  100
              }
            }
          : {})
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
    })),
    runServertoolOrchestrationMutationWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts',
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
      const executionMode =
        toolSpec?.execution?.mode ??
        input.options?.executionMode ??
        (trigger === 'auto' ? 'auto_hook' : 'guarded');
      return {
        name,
        enabled: toolSpec?.enabled ?? true,
        trigger,
        executionMode,
        stripAfterExecute: toolSpec?.execution?.stripAfterExecute ?? true,
        ...(trigger === 'auto'
          ? {
              autoHook: {
                id: name,
                phase: toolSpec?.trigger?.phase ?? input.options?.hook?.phase ?? input.options?.phase ?? 'default',
                priority:
                  toolSpec?.trigger?.priority ??
                  input.options?.hook?.priority ??
                  input.options?.priority ??
                  100
              }
            }
          : {})
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
    })),
    runServertoolOrchestrationMutationWithNative
  })
);

const planServertoolHookScheduleWithNative = jest.fn((input: any) => ({
  events: (input.hooks ?? []).map((hook: any) => ({
    hookId: hook.id,
    status: 'scheduled',
    effectKind: hook.effectKind,
    requiredness: hook.requiredness,
    noOp: false
  })),
  projection: {
    direction: 'response',
    phase: 'ServertoolRespHook01Intercepted',
    inputNode: 'HubRespChatProcess03Governed',
    outputNode: 'ServertoolRespHook01Intercepted',
    hookIds: (input.hooks ?? []).map((hook: any) => hook.id),
    effectKinds: (input.hooks ?? []).map((hook: any) => hook.effectKind)
  }
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistryRegistrationActionWithNative: jest.fn((input: any) => ({
      action:
        typeof input?.name === 'string' && input.name.trim()
          ? input?.builtinEntryPresent
            ? 'ignore_builtin_override'
            : input?.builtinNameMatched && input?.registrationAllowedByConfig === false
              ? 'ignore_disabled'
              : input?.hasHandler
                ? 'register_adhoc'
                : 'ignore_invalid'
          : 'ignore_invalid'
    })),
    planServertoolRegistryLookupActionWithNative: jest.fn((input: any) => ({
      action: input?.builtinEntryPresent
        ? 'return_builtin'
        : input?.adHocEntryPresent
          ? 'return_adhoc'
          : 'return_none'
    })),
    planServertoolRegistryAutoHookDescriptorsWithNative: jest.fn((input: any) =>
      Array.isArray(input?.hooks)
        ? input.hooks.map((hook: any) => ({
            id: String(hook?.id ?? '').trim().toLowerCase(),
            phase:
              hook?.phase === 'pre' || hook?.phase === 'post'
                ? hook.phase
                : 'default',
            priority: Number.isFinite(hook?.priority) ? Number(hook.priority) : 100,
            order: Number.isFinite(hook?.order) ? Number(hook.order) : 0
          }))
        : []
    ),
    planServertoolRegistryProjectionWithNative: jest.fn((input: any) => {
      const registeredNames = [...new Set(
        Array.isArray(input?.registeredNames)
          ? input.registeredNames.map((name: any) => String(name ?? '').trim().toLowerCase()).filter(Boolean)
          : []
      )].sort();
      const autoHandlerNames = Array.isArray(input?.autoHandlerNames)
        ? input.autoHandlerNames.map((name: any) => String(name ?? '').trim().toLowerCase()).filter(Boolean)
        : [];
      const registeredRecords = Array.isArray(input?.registeredRecords)
        ? input.registeredRecords
            .map((record: any) => ({
              name: String(record?.name ?? '').trim().toLowerCase(),
              trigger: String(record?.trigger ?? '').trim(),
              sourceIndex: Number(record?.sourceIndex)
            }))
            .filter((record: any) =>
              record.name &&
              (record.trigger === 'tool_call' || record.trigger === 'auto') &&
              Number.isInteger(record.sourceIndex) &&
              record.sourceIndex >= 0
            )
            .sort((left: any, right: any) => {
              const rank = (value: string) => (value === 'tool_call' ? 0 : 1);
              return rank(left.trigger) - rank(right.trigger) || left.sourceIndex - right.sourceIndex;
            })
        : [];
      return {
        registeredNames,
        registeredRecords,
        autoHandlerNames
      };
    }),
    planServertoolHookScheduleWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts',
  () => ({
    planServertoolRegistryRegistrationActionWithNative: jest.fn((input: any) => ({
      action:
        typeof input?.name === 'string' && input.name.trim()
          ? input?.builtinEntryPresent
            ? 'ignore_builtin_override'
            : input?.builtinNameMatched && input?.registrationAllowedByConfig === false
              ? 'ignore_disabled'
              : input?.hasHandler
                ? 'register_adhoc'
                : 'ignore_invalid'
          : 'ignore_invalid'
    })),
    planServertoolRegistryLookupActionWithNative: jest.fn((input: any) => ({
      action: input?.builtinEntryPresent
        ? 'return_builtin'
        : input?.adHocEntryPresent
          ? 'return_adhoc'
          : 'return_none'
    })),
    planServertoolRegistryAutoHookDescriptorsWithNative: jest.fn((input: any) =>
      Array.isArray(input?.hooks)
        ? input.hooks.map((hook: any) => ({
            id: String(hook?.id ?? '').trim().toLowerCase(),
            phase:
              hook?.phase === 'pre' || hook?.phase === 'post'
                ? hook.phase
                : 'default',
            priority: Number.isFinite(hook?.priority) ? Number(hook.priority) : 100,
            order: Number.isFinite(hook?.order) ? Number(hook.order) : 0
          }))
        : []
    ),
    planServertoolRegistryProjectionWithNative: jest.fn((input: any) => {
      const registeredNames = [...new Set(
        Array.isArray(input?.registeredNames)
          ? input.registeredNames.map((name: any) => String(name ?? '').trim().toLowerCase()).filter(Boolean)
          : []
      )].sort();
      const autoHandlerNames = Array.isArray(input?.autoHandlerNames)
        ? input.autoHandlerNames.map((name: any) => String(name ?? '').trim().toLowerCase()).filter(Boolean)
        : [];
      const registeredRecords = Array.isArray(input?.registeredRecords)
        ? input.registeredRecords
            .map((record: any) => ({
              name: String(record?.name ?? '').trim().toLowerCase(),
              trigger: String(record?.trigger ?? '').trim(),
              sourceIndex: Number(record?.sourceIndex)
            }))
            .filter((record: any) =>
              record.name &&
              (record.trigger === 'tool_call' || record.trigger === 'auto') &&
              Number.isInteger(record.sourceIndex) &&
              record.sourceIndex >= 0
            )
            .sort((left: any, right: any) => {
              const rank = (value: string) => (value === 'tool_call' ? 0 : 1);
              return rank(left.trigger) - rank(right.trigger) || left.sourceIndex - right.sourceIndex;
            })
        : [];
      return {
        registeredNames,
        registeredRecords,
        autoHandlerNames
      };
    }),
    planServertoolHookScheduleWithNative
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
let listRegisteredServerToolHandlerNames: any;
let listRegisteredServerToolHandlerRecords: any;
let buildAutoHookQueuesFromConfig: any;

beforeAll(async () => {
  const skeletonConfig = await import('../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js');
  buildServertoolAutoHookQueueConfig = skeletonConfig.buildServertoolAutoHookQueueConfig;
  buildServertoolFollowupConfig = skeletonConfig.buildServertoolFollowupConfig;
  buildServertoolPendingInjectionConfig = skeletonConfig.buildServertoolPendingInjectionConfig;
  getDefaultServertoolSkeletonDocument = skeletonConfig.getDefaultServertoolSkeletonDocument;
  getServertoolToolSpec = skeletonConfig.getServertoolToolSpec;
  normalizeServerToolRegistrationSpec = skeletonConfig.normalizeServerToolRegistrationSpec;
  const orchestrationBlocks = await import('../../sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.js');
  buildAutoHookQueuesFromConfig = orchestrationBlocks.buildAutoHookQueuesFromConfig;
  const registry = await import('../../sharedmodule/llmswitch-core/src/servertool/registry.js');
  registerServerToolHandler = registry.registerServerToolHandler;
  listAutoServerToolHooks = registry.listAutoServerToolHooks;
  listRegisteredServerToolHandlerNames = registry.listRegisteredServerToolHandlerNames;
  listRegisteredServerToolHandlerRecords = registry.listRegisteredServerToolHandlerRecords;

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
    const spec = normalizeServerToolRegistrationSpec('reasoningStop', {
      trigger: 'tool_call'
    });
    expect(spec).toMatchObject({
      name: 'reasoningstop',
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
    expect(getServertoolToolSpec('reasoningStop')).toBeNull();
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

  test('registry projection keeps native-owned name order and trigger grouping', () => {
    registerServerToolHandler('custom_registry_tool', async () => null, {
      trigger: 'tool_call'
    });
    registerServerToolHandler('custom_registry_auto', async () => null, {
      trigger: 'auto'
    });

    expect(listRegisteredServerToolHandlerNames()).toEqual([
      'custom_registry_tool',
      'stop_message_auto'
    ]);
    expect(
      listRegisteredServerToolHandlerRecords().map((entry: any) => ({
        name: entry.registration.name,
        trigger: entry.registration.trigger
      }))
    ).toEqual([
      { name: 'custom_registry_tool', trigger: 'tool_call' },
      { name: 'stop_message_auto', trigger: 'auto' },
      { name: 'custom_registry_auto', trigger: 'auto' }
    ]);
  });

  test('adhoc registration defaults also come from native normalization', async () => {
    registerServerToolHandler('custom_native_defaults_tool', async () => null);
    registerServerToolHandler('custom_native_defaults_auto', async () => null, {
      trigger: 'auto'
    });

    const records = listRegisteredServerToolHandlerRecords().map((entry: any) => ({
      name: entry.registration.name,
      trigger: entry.registration.trigger,
      executionMode: entry.registration.executionMode,
      stripAfterExecute: entry.registration.stripAfterExecute,
      autoHook: entry.registration.autoHook
    }));

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'custom_native_defaults_tool',
          trigger: 'tool_call',
          executionMode: 'guarded',
          stripAfterExecute: true
        }),
        expect.objectContaining({
          name: 'custom_native_defaults_auto',
          trigger: 'auto',
          executionMode: 'auto_hook',
          stripAfterExecute: true,
          autoHook: expect.objectContaining({
            id: 'custom_native_defaults_auto',
            phase: 'default',
            priority: 100
          })
        })
      ])
    );
  });

  test('auto hook queue order is finalized by native hook skeleton scheduler', () => {
    planServertoolHookScheduleWithNative.mockImplementationOnce((input: any) => ({
      events: (input.hooks ?? []).map((hook: any) => ({
        hookId: hook.id,
        status: 'scheduled',
        effectKind: hook.effectKind,
        requiredness: hook.requiredness,
        noOp: false
      })),
      projection: {
        direction: 'response',
        phase: 'ServertoolRespHook01Intercepted',
        inputNode: 'HubRespChatProcess03Governed',
        outputNode: 'ServertoolRespHook01Intercepted',
        hookIds: ['stop_message_auto', 'vision_auto'],
        effectKinds: ['auto_hook:stop_message_auto:optional', 'auto_hook:vision_auto:optional']
      }
    }));

    const queues = buildAutoHookQueuesFromConfig({
      hooks: [
        { id: 'vision_auto', phase: 'default', priority: 20, order: 0 },
        { id: 'stop_message_auto', phase: 'default', priority: 40, order: 0 }
      ],
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });

    expect(queues.optionalQueue.map((hook: any) => hook.id)).toEqual([
      'stop_message_auto',
      'vision_auto'
    ]);
    expect(planServertoolHookScheduleWithNative).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'response',
        respPhase: 'servertoolRespHook01Intercepted'
      })
    );
  });

});
