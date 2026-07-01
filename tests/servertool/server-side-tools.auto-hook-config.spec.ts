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
      },
      reasoningstop: {
        name: 'reasoningStop',
        enabled: true,
        trigger: { type: 'tool_call', canonicalName: 'reasoningStop' },
        execution: { mode: 'guarded', stripAfterExecute: true }
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
const planServertoolAutoHookQueuesWithNative = jest.fn((input: any) => ({
  optionalQueue: [...input.hooks].sort((a, b) => a.priority - b.priority),
  mandatoryQueue: [],
  queueOrder: [
    {
      queue: 'A_optional',
      entries: [...input.hooks].sort((a, b) => a.priority - b.priority)
    },
    {
      queue: 'B_mandatory',
      entries: []
    }
  ]
}));

function mockToolSpec(name: unknown): any | null {
  const key = String(name ?? '').trim().toLowerCase();
  return (skeletonDocument.servertool.internalTools as Record<string, any>)[key] ?? null;
}

function mockRegistrySourceProjection(input: any): any {
  const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();
  const normalizeRecord = (record: any, sourceIndex: number) => ({
    name: normalize(record?.name),
    trigger: String(record?.trigger ?? '').trim(),
    source: 'builtin',
    sourceIndex
  });
  const validRecord = (record: any) =>
    record.name && (record.trigger === 'tool_call' || record.trigger === 'auto');
  const registeredNames = [...new Set([
    ...(Array.isArray(input?.builtinNames) ? input.builtinNames.map(normalize).filter(Boolean) : [])
  ])].sort();
  const autoHandlerRefs = [
    ...(Array.isArray(input?.builtinAutoHandlerNames)
      ? input.builtinAutoHandlerNames.map((name: any, sourceIndex: number) => ({
          name: normalize(name),
          source: 'builtin' as const,
          sourceIndex
        }))
      : [])
  ].filter((entry) => entry.name);
  const records = [
    ...(Array.isArray(input?.builtinRecords)
      ? input.builtinRecords.map((record: any, sourceIndex: number) =>
          normalizeRecord(record, sourceIndex)
        )
      : [])
  ].filter(validRecord);
  return {
    registeredNames,
    autoHandlerRefs,
    registeredRecordRefs: [
      ...records.filter((record) => record.trigger === 'tool_call'),
      ...records.filter((record) => record.trigger === 'auto')
    ]
  };
}

function mockRegistryLookupFromSkeleton(input: any): any {
  const name = String(input?.name ?? '').trim().toLowerCase();
  if (!name) {
    return { action: 'return_none' };
  }
  const spec = name === 'stop_message_auto' ? mockToolSpec(name) : null;
  if (spec && spec.enabled !== false) {
    return { action: 'return_builtin', canonicalName: name };
  }
  return { action: 'return_none', canonicalName: name };
}

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
      requiresPendingInjection: false,
      remainingToolCallIds: [],
      flowId: 'servertool_multi'
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
          ignoreRequiresActionFollowupFlowIds: []
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
      return mockToolSpec(input.name);
    }),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(
      mockRegistryLookupFromSkeleton
    ),
    planServertoolBuiltinHandlerEntryWithNative: jest.fn((input: any) => {
      const name = String(input.name ?? '').trim().toLowerCase();
      if (name !== 'stop_message_auto') {
        return { action: 'return_none' };
      }
      const spec = (skeletonDocument.servertool.internalTools as Record<string, any>)[name];
      return {
        action: 'return_entry',
        entry: {
          name,
          trigger: spec.trigger.type,
          execution: { kind: 'builtin', builtinName: name },
          registration: {
            name,
            enabled: true,
            trigger: spec.trigger.type,
            executionMode: spec.execution.mode,
            stripAfterExecute: spec.execution.stripAfterExecute,
            autoHook: {
              id: name,
              phase: spec.trigger.phase ?? 'default',
              priority: spec.trigger.priority ?? 100
            }
          },
          autoHook: {
            id: name,
            phase: spec.trigger.phase ?? 'default',
            priority: spec.trigger.priority ?? 100,
            order: -1
          }
        }
      };
    }),
    planServertoolBuiltinHandlerNamesWithNative: jest.fn(() => ({
      names: ['stop_message_auto']
    })),
    resolveServertoolBuiltinHandlerEntryWithNative: jest.fn((input: any) => {
      const name = String(input.name ?? '').trim().toLowerCase();
      if (name !== 'stop_message_auto') {
        return null;
      }
      const spec = (skeletonDocument.servertool.internalTools as Record<string, any>)[name];
      return {
        name,
        trigger: spec.trigger.type,
        execution: { kind: 'builtin', builtinName: name },
        registration: {
          name,
          enabled: true,
          trigger: spec.trigger.type,
          executionMode: spec.execution.mode,
          stripAfterExecute: spec.execution.stripAfterExecute,
          autoHook: {
            id: name,
            phase: spec.trigger.phase ?? 'default',
            priority: spec.trigger.priority ?? 100
          }
        },
        autoHook: {
          id: name,
          phase: spec.trigger.phase ?? 'default',
          priority: spec.trigger.priority ?? 100,
          order: -1
        }
      };
    }),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => ({
      entries: [{
        name: 'stop_message_auto',
        trigger: 'auto',
        execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
        registration: {
          name: 'stop_message_auto',
          enabled: true,
          trigger: 'auto',
          executionMode: 'auto_hook',
          stripAfterExecute: true,
          autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40 }
        },
        autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40, order: -1 }
      }]
    })),
    planServertoolBuiltinHandlerRecordEntriesWithNative: jest.fn(() => ({
      entries: [{
        name: 'stop_message_auto',
        trigger: 'auto',
        execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
        registration: {
          name: 'stop_message_auto',
          enabled: true,
          trigger: 'auto',
          executionMode: 'auto_hook',
          stripAfterExecute: true,
          autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40 }
        },
        autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40, order: -1 }
      }]
    })),
    extractCapturedChatSeedWithNative: jest.fn(() => null),
    normalizeFollowupParametersWithNative: jest.fn((value: any) => value ?? undefined),
    resolveFollowupModelWithNative: jest.fn((seedModel: any) => String(seedModel ?? 'gpt-test')),
    buildServertoolToolOutputPayloadWithNative: jest.fn((payload: any) => payload),
    webSearchIsGeminiEngineWithNative: jest.fn(() => false),
    webSearchIsGlmEngineWithNative: jest.fn(() => false),
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
    planServertoolAutoHookQueuesWithNative,
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
      requiresPendingInjection: false,
      remainingToolCallIds: [],
      flowId: 'servertool_multi'
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
          ignoreRequiresActionFollowupFlowIds: []
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
      return mockToolSpec(input.name);
    }),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(
      mockRegistryLookupFromSkeleton
    ),
    planServertoolBuiltinHandlerEntryWithNative: jest.fn((input: any) => {
      const name = String(input.name ?? '').trim().toLowerCase();
      if (name !== 'stop_message_auto') {
        return { action: 'return_none' };
      }
      const spec = (skeletonDocument.servertool.internalTools as Record<string, any>)[name];
      return {
        action: 'return_entry',
        entry: {
          name,
          trigger: spec.trigger.type,
          execution: { kind: 'builtin', builtinName: name },
          registration: {
            name,
            enabled: true,
            trigger: spec.trigger.type,
            executionMode: spec.execution.mode,
            stripAfterExecute: spec.execution.stripAfterExecute,
            autoHook: {
              id: name,
              phase: spec.trigger.phase ?? 'default',
              priority: spec.trigger.priority ?? 100
            }
          },
          autoHook: {
            id: name,
            phase: spec.trigger.phase ?? 'default',
            priority: spec.trigger.priority ?? 100,
            order: -1
          }
        }
      };
    }),
    planServertoolBuiltinHandlerNamesWithNative: jest.fn(() => ({
      names: ['stop_message_auto']
    })),
    resolveServertoolBuiltinHandlerEntryWithNative: jest.fn((input: any) => {
      const name = String(input.name ?? '').trim().toLowerCase();
      if (name !== 'stop_message_auto') {
        return null;
      }
      const spec = (skeletonDocument.servertool.internalTools as Record<string, any>)[name];
      return {
        name,
        trigger: spec.trigger.type,
        execution: { kind: 'builtin', builtinName: name },
        registration: {
          name,
          enabled: true,
          trigger: spec.trigger.type,
          executionMode: spec.execution.mode,
          stripAfterExecute: spec.execution.stripAfterExecute,
          autoHook: {
            id: name,
            phase: spec.trigger.phase ?? 'default',
            priority: spec.trigger.priority ?? 100
          }
        },
        autoHook: {
          id: name,
          phase: spec.trigger.phase ?? 'default',
          priority: spec.trigger.priority ?? 100,
          order: -1
        }
      };
    }),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => ({
      entries: [{
        name: 'stop_message_auto',
        trigger: 'auto',
        execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
        registration: {
          name: 'stop_message_auto',
          enabled: true,
          trigger: 'auto',
          executionMode: 'auto_hook',
          stripAfterExecute: true,
          autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40 }
        },
        autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40, order: -1 }
      }]
    })),
    planServertoolBuiltinHandlerRecordEntriesWithNative: jest.fn(() => ({
      entries: [{
        name: 'stop_message_auto',
        trigger: 'auto',
        execution: { kind: 'builtin', builtinName: 'stop_message_auto' },
        registration: {
          name: 'stop_message_auto',
          enabled: true,
          trigger: 'auto',
          executionMode: 'auto_hook',
          stripAfterExecute: true,
          autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40 }
        },
        autoHook: { id: 'stop_message_auto', phase: 'default', priority: 40, order: -1 }
      }]
    })),
    extractCapturedChatSeedWithNative: jest.fn(() => null),
    normalizeFollowupParametersWithNative: jest.fn((value: any) => value ?? undefined),
    resolveFollowupModelWithNative: jest.fn((seedModel: any) => String(seedModel ?? 'gpt-test')),
    buildServertoolToolOutputPayloadWithNative: jest.fn((payload: any) => payload),
    webSearchIsGeminiEngineWithNative: jest.fn(() => false),
    webSearchIsGlmEngineWithNative: jest.fn(() => false),
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
    planServertoolAutoHookQueuesWithNative,
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
    planServertoolRegistryLookupActionWithNative: jest.fn((input: any) => ({
      action: input?.builtinEntryPresent
        ? 'return_builtin'
        : 'return_none'
    })),
    planServertoolRegistryAutoHookDescriptorsWithNative: jest.fn((input: any) =>
      Array.isArray(input?.hooks)
        ? input.hooks.map((hook: any, sourceIndex: number) => ({
            id: String(hook?.id ?? '').trim().toLowerCase(),
            phase:
              hook?.phase === 'pre' || hook?.phase === 'post'
                ? hook.phase
                : 'default',
            priority: Number.isFinite(hook?.priority) ? Number(hook.priority) : 100,
            order: Number.isFinite(hook?.order) ? Number(hook.order) : 0,
            sourceIndex
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
    planServertoolRegistrySourceProjectionWithNative: jest.fn(mockRegistrySourceProjection),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(() => ({
      kind: 'stopless',
      stdout: '{}'
    })),
    planServertoolHookScheduleWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts',
  () => ({
    planServertoolRegistryLookupActionWithNative: jest.fn((input: any) => ({
      action: input?.builtinEntryPresent
        ? 'return_builtin'
        : 'return_none'
    })),
    planServertoolRegistryAutoHookDescriptorsWithNative: jest.fn((input: any) =>
      Array.isArray(input?.hooks)
        ? input.hooks.map((hook: any, sourceIndex: number) => ({
            id: String(hook?.id ?? '').trim().toLowerCase(),
            phase:
              hook?.phase === 'pre' || hook?.phase === 'post'
                ? hook.phase
                : 'default',
            priority: Number.isFinite(hook?.priority) ? Number(hook.priority) : 100,
            order: Number.isFinite(hook?.order) ? Number(hook.order) : 0,
            sourceIndex
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
    planServertoolRegistrySourceProjectionWithNative: jest.fn(mockRegistrySourceProjection),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(() => ({
      kind: 'stopless',
      stdout: '{}'
    })),
    planServertoolHookScheduleWithNative
  })
);

let buildServertoolAutoHookQueueConfig: any;
let buildServertoolFollowupConfig: any;
let buildServertoolPendingInjectionConfig: any;
let normalizeServerToolRegistrationSpec: any;
let listAutoServerToolHooks: any;

beforeAll(async () => {
  const nativeServertoolOrchestration = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js');
  buildServertoolAutoHookQueueConfig = () => nativeServertoolOrchestration.planServertoolSkeletonDerivedConfigWithNative().autoHookQueueConfig;
  buildServertoolFollowupConfig = () => nativeServertoolOrchestration.planServertoolSkeletonDerivedConfigWithNative().followupConfig;
  buildServertoolPendingInjectionConfig = () => nativeServertoolOrchestration.planServertoolSkeletonDerivedConfigWithNative().pendingInjectionConfig;
  normalizeServerToolRegistrationSpec = (name: string, options: Record<string, unknown>) =>
    nativeServertoolOrchestration.normalizeServertoolRegistrationSpecWithNative({ name, options });
  const registry = await import('../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js');
  listAutoServerToolHooks = registry.listAutoServerToolHooks;

});

describe('servertool skeleton config', () => {
  test('exposes declarative auto hook queue order from skeleton config', () => {
    const skeleton = skeletonDocument;
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
    const stopMessage = skeletonDocument.servertool.internalTools.stop_message_auto;
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
    expect(skeletonDocument.servertool.internalTools.reasoningstop).toMatchObject({
      name: 'reasoningStop',
      trigger: {
        type: 'tool_call',
        canonicalName: 'reasoningStop'
      },
      execution: {
        mode: 'guarded',
        stripAfterExecute: true
      }
    });
  });

  test('registry exposes skeleton-owned auto hooks without TS overrides', () => {
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

  test('registry shell does not expose test-only registered-name or record listing APIs', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts',
        'utf8'
      )
    );

    expect(source).not.toContain('export function listRegisteredServerToolHandlerNames(');
    expect(source).not.toContain('export function listRegisteredServerToolHandlerRecords(');
  });

  test('auto hook queue order is consumed inside caller from the Rust auto-hook queue planner', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')
    );

    expect(source).toContain('planServertoolAutoHookQueuesWithNative({');
    expect(source).toContain('sourceIndex');
    expect(source).toContain('args.hooks[entry.sourceIndex]');
    expect(planServertoolHookScheduleWithNative).not.toHaveBeenCalled();
  });

  test('auto hook queue shell does not expose a reusable TS queue builder', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.ts', 'utf8')
    );

    expect(source).not.toContain('buildAutoHookQueuesFromConfig');
    expect(source).not.toContain('planServertoolAutoHookQueuesWithNative');
    expect(source).not.toContain('.filter((hook): hook is');
    expect(source).not.toContain('.filter(Boolean)');
    expect(source).not.toContain('function normalizeServerToolCallName(');
    expect(source).not.toContain('.trim().toLowerCase()');
  });

});
