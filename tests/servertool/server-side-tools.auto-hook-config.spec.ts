import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const skeletonDocument = {
  servertool: {
    skeleton: {
      autoHooks: {
        optionalPrimaryOrder: [],
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
          profilesByFlowId: {}
        }
      }
    },
    state: {
      scopePriority: [],
      pendingInjection: { enabled: true, strictContract: true }
    },
    internalTools: {}
  }
};

const derivedConfig = {
  document: skeletonDocument,
  toolSpecs: {},
  toolSpecList: [],
  autoHookQueueConfig: {
    optionalPrimaryOrder: [],
    mandatoryOrder: []
  },
  pendingInjectionConfig: {
    messageKinds: ['assistant_tool_calls', 'tool_outputs']
  },
  followupConfig: {
    genericInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs'],
    nativeSupportedOps: [],
    flowPolicy: {
      profilesByFlowId: {},
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
};

const normalizeName = (value: unknown): string => String(value ?? '').trim().toLowerCase();

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

const planServertoolAutoHookQueueItemsWithNative = jest.fn(() => ({
  queueOrder: [
    { queue: 'A_optional', entries: [] },
    { queue: 'B_mandatory', entries: [] }
  ]
}));

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
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
    planServertoolSkeletonDerivedConfigWithNative: jest.fn(() => derivedConfig),
    normalizeServertoolRegistrationSpecWithNative: jest.fn((input: any) => {
      const name = normalizeName(input.name);
      if (!name) {
        return null;
      }
      const trigger = String(input.options?.trigger ?? 'tool_call').trim();
      const executionMode =
        input.options?.executionMode ?? (trigger === 'auto' ? 'auto_hook' : 'guarded');
      return {
        name,
        enabled: true,
        trigger,
        executionMode,
        stripAfterExecute: true,
        ...(trigger === 'auto'
          ? {
              autoHook: {
                id: name,
                phase: input.options?.hook?.phase ?? input.options?.phase ?? 'default',
                priority: input.options?.hook?.priority ?? input.options?.priority ?? 100
              }
            }
          : {})
      };
    }),
    resolveServertoolToolSpecWithNative: jest.fn(() => null),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn((input: any) => {
      const name = normalizeName(input?.name);
      return name ? { action: 'return_none', canonicalName: name } : { action: 'return_none' };
    }),
    planServertoolBuiltinHandlerEntryWithNative: jest.fn(() => ({ action: 'return_none' })),
    planServertoolBuiltinHandlerNamesWithNative: jest.fn(() => ({ names: [] })),
    resolveServertoolBuiltinHandlerEntryWithNative: jest.fn(() => null),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => ({ entries: [] })),
    resolveServertoolRegistryHandlerWithNative: jest.fn(() => null),
    planServertoolBuiltinHandlerRecordEntriesWithNative: jest.fn(() => ({ entries: [] })),
    planServertoolRegistryBuiltinAutoHookEntriesWithNative: jest.fn(() => []),
    planServertoolRegistryProjectionWithNative: jest.fn((input: any) => ({
      registeredNames: Array.isArray(input?.registeredNames)
        ? [...new Set(input.registeredNames.map(normalizeName).filter(Boolean))].sort()
        : [],
      registeredRecords: [],
      autoHandlerNames: []
    })),
    planServertoolRegistrySourceProjectionWithNative: jest.fn(() => ({
      registeredNames: [],
      autoHandlerRefs: [],
      registeredRecordRefs: []
    })),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(() => ({
      kind: 'stopless',
      stdout: '{}'
    })),
    planServertoolHookScheduleWithNative,
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
    planServertoolAutoHookQueueItemsWithNative,
    materializeServertoolPlannedResultWithNative: jest.fn(),
    resolveAutoHookCallerFinalizationDecisionWithNative: jest.fn(),
    resolveAutoHookRuntimeAttemptDecisionWithNative: jest.fn(),
    runServertoolOrchestrationMutationWithNative: jest.fn((input: any) => input?.base ?? {})
  })
);

let nativeServertoolOrchestration: any;
let buildServertoolAutoHookQueueConfig: any;
let buildServertoolFollowupConfig: any;
let buildServertoolPendingInjectionConfig: any;
let normalizeServerToolRegistrationSpec: any;

beforeAll(async () => {
  nativeServertoolOrchestration = await import('rcc-llmswitch-core/native/servertool-wrapper');
  buildServertoolAutoHookQueueConfig = () =>
    nativeServertoolOrchestration.planServertoolSkeletonDerivedConfigWithNative().autoHookQueueConfig;
  buildServertoolFollowupConfig = () =>
    nativeServertoolOrchestration.planServertoolSkeletonDerivedConfigWithNative().followupConfig;
  buildServertoolPendingInjectionConfig = () =>
    nativeServertoolOrchestration.planServertoolSkeletonDerivedConfigWithNative().pendingInjectionConfig;
  normalizeServerToolRegistrationSpec = (name: string, options: Record<string, unknown>) =>
    nativeServertoolOrchestration.normalizeServertoolRegistrationSpecWithNative({ name, options });
});

describe('servertool skeleton config', () => {
  test('default skeleton has no server-side tool registry entries', () => {
    expect(skeletonDocument.servertool.internalTools).toEqual({});
    expect(skeletonDocument.servertool.skeleton.autoHooks.optionalPrimaryOrder).toEqual([]);
    expect(buildServertoolAutoHookQueueConfig()).toEqual({
      optionalPrimaryOrder: [],
      mandatoryOrder: []
    });
    expect(nativeServertoolOrchestration.planServertoolSkeletonDerivedConfigWithNative()).toMatchObject({
      toolSpecs: {},
      toolSpecList: []
    });
    expect(buildServertoolPendingInjectionConfig()).toEqual({
      messageKinds: ['assistant_tool_calls', 'tool_outputs']
    });
    expect(buildServertoolFollowupConfig().flowPolicy.profilesByFlowId).toEqual({});
  });

  test('registry and builtin helpers return empty defaults for CLI-owned tools', () => {
    for (const name of ['stop_message_auto', 'web_search', 'vision_auto', 'reasoningStop']) {
      expect(
        nativeServertoolOrchestration.planServertoolRegistryLookupFromSkeletonWithNative({ name })
      ).toMatchObject({ action: 'return_none' });
      expect(nativeServertoolOrchestration.resolveServertoolToolSpecWithNative({ name })).toBeNull();
      expect(nativeServertoolOrchestration.resolveServertoolBuiltinHandlerEntryWithNative({ name })).toBeNull();
      expect(nativeServertoolOrchestration.resolveServertoolRegistryHandlerWithNative({ name })).toBeNull();
    }
    expect(nativeServertoolOrchestration.planServertoolBuiltinHandlerNamesWithNative({})).toEqual({ names: [] });
    expect(nativeServertoolOrchestration.planServertoolBuiltinAutoHandlerEntriesWithNative({})).toEqual({ entries: [] });
    expect(nativeServertoolOrchestration.planServertoolBuiltinHandlerRecordEntriesWithNative({})).toEqual({ entries: [] });
  });

  test('normalizes explicit registration input without restoring skeleton defaults', () => {
    expect(normalizeServerToolRegistrationSpec('reasoningStop', { trigger: 'tool_call' })).toMatchObject({
      name: 'reasoningstop',
      enabled: true,
      trigger: 'tool_call',
      executionMode: 'guarded',
      stripAfterExecute: true
    });
    expect(normalizeServerToolRegistrationSpec('stop_message_auto', { trigger: 'auto' })).toMatchObject({
      name: 'stop_message_auto',
      enabled: true,
      trigger: 'auto',
      executionMode: 'auto_hook',
      stripAfterExecute: true
    });
    expect(skeletonDocument.servertool.internalTools).toEqual({});
  });

  test('auto-hook registry helper stays internal to caller shell', async () => {
    const [mod, source] = await Promise.all([
      import('../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js'),
      import('node:fs/promises').then((fs) =>
        fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')
      )
    ]);

    expect((mod as Record<string, unknown>).listAutoServerToolHooks).toBeUndefined();
    expect(source).toContain('const listAutoServerToolHooks =');
    expect(source).not.toContain('export const listAutoServerToolHooks');
    expect(source).toContain('planServertoolRegistryBuiltinAutoHookEntriesWithNative({');
  });

  test('deleted registry shell does not expose test-only registered-name or record listing APIs', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')
    );
    await expect(
      import('node:fs/promises').then((fs) =>
        fs.access('sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts')
      )
    ).rejects.toThrow();

    expect(source).not.toContain('export function listRegisteredServerToolHandlerNames(');
    expect(source).not.toContain('export function listRegisteredServerToolHandlerRecords(');
  });

  test('auto hook queue order is consumed inside caller from the Rust auto-hook queue planner', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')
    );

    expect(source).toContain('planServertoolAutoHookQueueItemsWithNative({');
    expect(source).not.toContain('planServertoolAutoHookQueuesWithNative({');
    expect(source).not.toContain('planServertoolSkeletonDerivedConfigWithNative');
    expect(source).not.toContain('autoHookQueueConfig as');
    expect(source).not.toContain('optionalPrimaryHookOrder');
    expect(source).not.toContain('mandatoryHookOrder');
    expect(source).not.toContain('args.hooks[entry.sourceIndex]');
    expect(source).not.toContain('native auto-hook queue returned invalid sourceIndex');
    expect(planServertoolHookScheduleWithNative).not.toHaveBeenCalled();
  });

  test('auto hook queue shell does not expose a reusable TS queue builder', async () => {
    const fs = await import('node:fs/promises');
    await expect(
      fs.access('sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.ts')
    ).rejects.toThrow();
    const source = await fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8');

    expect(source).not.toContain('buildAutoHookQueuesFromConfig');
    expect(source).not.toContain('planServertoolAutoHookQueuesWithNative');
    expect(source).not.toContain('.filter((hook): hook is');
    expect(source).not.toContain('.filter(Boolean)');
    expect(source).not.toContain('function normalizeServerToolCallName(');
    expect(source).not.toContain('.trim().toLowerCase()');
  });
});
