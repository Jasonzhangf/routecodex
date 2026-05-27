import type { ServerToolHandler } from './types.js';
import { getDefaultServertoolSkeletonDocumentWithNative } from '../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import type {
  ServertoolTriggerMode,
  ServertoolAutoHookPhase,
  ServertoolExecutionMode,
  ServertoolSkeletonStageConfig,
  ServertoolSkeletonConfig,
  ServertoolStateConfig,
  ServertoolToolSpec,
  ServertoolSkeletonDocument,
  ServerToolHandlerRegistrationSpec,
  ServerToolRegisteredHandlerRecord,
} from '../router/virtual-router/engine-selection/native-followup-mainline-semantics.js';
export type {
  ServertoolTriggerMode,
  ServertoolAutoHookPhase,
  ServertoolExecutionMode,
  ServertoolSkeletonStageConfig,
  ServertoolSkeletonConfig,
  ServertoolStateConfig,
  ServertoolToolSpec,
  ServertoolSkeletonDocument,
  ServerToolHandlerRegistrationSpec,
  ServerToolRegisteredHandlerRecord,
} from '../router/virtual-router/engine-selection/native-followup-mainline-semantics.js';

// Types moved to native-followup-mainline-semantics.ts







function normalizeServerToolName(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!key) {
    return '';
  }
  if (key === 'websearch' || key === 'web-search') {
    return 'web_search';
  }
  return key;
}

function normalizeAutoHookPhase(value: unknown): ServertoolAutoHookPhase {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'pre' || normalized === 'before') {
    return 'pre';
  }
  if (normalized === 'post' || normalized === 'after') {
    return 'post';
  }
  return 'default';
}

function normalizeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  throw new Error('normalizeInteger: invalid integer value');
}

export function getDefaultServertoolSkeletonDocument(): ServertoolSkeletonDocument {
  return JSON.parse(
    JSON.stringify(getDefaultServertoolSkeletonDocumentWithNative())
  ) as ServertoolSkeletonDocument;
}

export function getServertoolToolSpec(name: string): ServertoolToolSpec | null {
  const canonicalName = normalizeServerToolName(name);
  if (!canonicalName) {
    return null;
  }
  const skeleton = getDefaultServertoolSkeletonDocument();
  return skeleton.servertool.internalTools[canonicalName] ?? null;
}

export function listServertoolToolSpecs(): ServertoolToolSpec[] {
  const skeleton = getDefaultServertoolSkeletonDocument();
  return Object.values(skeleton.servertool.internalTools);
}

export function normalizeServerToolRegistrationSpec(
  name: string,
  options: {
    trigger?: ServertoolTriggerMode;
    priority?: number;
    phase?: ServertoolAutoHookPhase | string;
    executionMode?: ServertoolExecutionMode;
    hook?: {
      priority?: number;
      phase?: ServertoolAutoHookPhase | string;
    };
  } = {}
): ServerToolHandlerRegistrationSpec | null {
  const canonicalName = normalizeServerToolName(name);
  if (!canonicalName) {
    return null;
  }
  const toolSpec = getServertoolToolSpec(canonicalName);
  const trigger = toolSpec?.trigger.type ?? options.trigger ?? 'tool_call';
  const executionMode =
    toolSpec?.execution.mode ?? options.executionMode ?? (trigger === 'auto' ? 'auto_hook' : 'guarded');
  const enabled = toolSpec?.enabled ?? true;
  const stripAfterExecute = toolSpec?.execution.stripAfterExecute ?? true;
  if (trigger === 'auto') {
    const phase = normalizeAutoHookPhase(
      toolSpec?.trigger.phase ?? options.hook?.phase ?? options.phase
    );
    const rawPriority = toolSpec?.trigger.priority ?? options.hook?.priority ?? options.priority;
    if (rawPriority === undefined || rawPriority === null) {
      throw new Error('normalizeInteger: priority is required');
    }
    const priority = normalizeInteger(rawPriority);
    return {
      name: canonicalName,
      enabled,
      trigger,
      executionMode,
      stripAfterExecute,
      autoHook: {
        id: canonicalName,
        phase,
        priority
      }
    };
  }
  return {
    name: canonicalName,
    enabled,
    trigger,
    executionMode,
    stripAfterExecute
  };
}

export function buildServertoolAutoHookQueueConfig(): {
  optionalPrimaryOrder: string[];
  mandatoryOrder: string[];
} {
  const skeleton = getDefaultServertoolSkeletonDocument();
  const optionalPrimaryOrder = [...skeleton.servertool.skeleton.autoHooks.optionalPrimaryOrder]
      .map((value) => normalizeServerToolName(value))
      .filter(Boolean);
  if (!optionalPrimaryOrder.includes('empty_reply_continue')) {
    const stopIdx = optionalPrimaryOrder.indexOf('stop_message_auto');
    if (stopIdx >= 0) optionalPrimaryOrder.splice(stopIdx, 0, 'empty_reply_continue');
    else optionalPrimaryOrder.push('empty_reply_continue');
  }
  return {
    optionalPrimaryOrder,
    mandatoryOrder: [...skeleton.servertool.skeleton.autoHooks.mandatoryOrder]
      .map((value) => normalizeServerToolName(value))
      .filter(Boolean)
  };
}

export function buildServertoolPendingInjectionConfig(): {
  messageKinds: string[];
} {
  const skeleton = getDefaultServertoolSkeletonDocument();
  return {
    messageKinds: [...skeleton.servertool.skeleton.pendingInjection.messageKinds]
      .map((value) => normalizeServerToolName(value) || (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  };
}

export function buildServertoolProgressConfig(): {
  toolNameByFlowId: Record<string, string>;
  goldHighlightFlowIds: string[];
} {
  const skeleton = getDefaultServertoolSkeletonDocument();
  return {
    toolNameByFlowId: Object.fromEntries(
      Object.entries(skeleton.servertool.skeleton.progress.toolNameByFlowId ?? {})
        .map(([key, value]) => [
          typeof key === 'string' ? key.trim() : '',
          typeof value === 'string' ? value.trim() : ''
        ])
        .filter(([key, value]) => Boolean(key) && Boolean(value))
    ),
    goldHighlightFlowIds: [...(skeleton.servertool.skeleton.progress.goldHighlightFlowIds ?? [])]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  };
}

export function buildServertoolFollowupConfig(): {
  genericInjectionOps: string[];
  nativeSupportedOps: string[];
  flowPolicy: {
    profilesByFlowId: Record<string, {
      noFollowup?: boolean;
      autoLimit?: boolean;
      flowOnlyLoopLimit?: boolean;
      stickyProvider?: boolean;
      clientInjectOnly?: boolean;
      clearStateOnFollowupFailure?: boolean;
      seedLoopPayload?: boolean;
      retryEmptyFollowupOnce?: boolean;
      clientInjectSource?: string;
      transparentReplayRequestSuffix?: string;
      ignoreRequiresActionFollowup?: boolean;
      contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
    }>;
    noFollowupFlowIds: string[];
    autoLimitFlowIds: string[];
    flowOnlyLoopLimitFlowIds: string[];
    stickyProviderFlowIds: string[];
    clientInjectOnlyFlowIds: string[];
    seedLoopPayloadFlowIds: string[];
    retryEmptyFollowupOnceFlowIds: string[];
    clientInjectSourceByFlowId: Record<string, string>;
    transparentReplayRequestSuffixByFlowId: Record<string, string>;
    ignoreRequiresActionFollowupFlowIds: string[];
    contextDecorationModeByFlowId: Record<string, 'continue_execution_summary' | 'web_search_summary'>;
  };
} {
  const skeleton = getDefaultServertoolSkeletonDocument();
  return {
    genericInjectionOps: [...skeleton.servertool.skeleton.followup.genericInjectionOps]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean),
    nativeSupportedOps: [...skeleton.servertool.skeleton.followup.nativeSupportedOps]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean),
    flowPolicy: {
      profilesByFlowId: Object.fromEntries(
        Object.entries(skeleton.servertool.skeleton.followup.flowPolicy.profilesByFlowId ?? {})
          .map(([key, value]) => {
            const flowId = typeof key === 'string' ? key.trim() : '';
            const profile =
              value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
            const normalized = {
              ...(profile.noFollowup === true ? { noFollowup: true } : {}),
              ...(profile.autoLimit === true ? { autoLimit: true } : {}),
              ...(profile.flowOnlyLoopLimit === true ? { flowOnlyLoopLimit: true } : {}),
              ...(profile.stickyProvider === true ? { stickyProvider: true } : {}),
              ...(profile.clientInjectOnly === true ? { clientInjectOnly: true } : {}),
              ...(profile.clearStateOnFollowupFailure === true ? { clearStateOnFollowupFailure: true } : {}),
              ...(profile.seedLoopPayload === true ? { seedLoopPayload: true } : {}),
              ...(profile.retryEmptyFollowupOnce === true ? { retryEmptyFollowupOnce: true } : {}),
              ...(typeof profile.clientInjectSource === 'string' && profile.clientInjectSource.trim()
                ? { clientInjectSource: profile.clientInjectSource.trim() }
                : {}),
              ...(typeof profile.transparentReplayRequestSuffix === 'string' && profile.transparentReplayRequestSuffix.trim()
                ? { transparentReplayRequestSuffix: profile.transparentReplayRequestSuffix.trim() }
                : {}),
              ...(profile.ignoreRequiresActionFollowup === true ? { ignoreRequiresActionFollowup: true } : {}),
              ...(profile.contextDecorationMode === 'continue_execution_summary' || profile.contextDecorationMode === 'web_search_summary'
                ? { contextDecorationMode: profile.contextDecorationMode }
                : {})
            };
            return [flowId, normalized];
          })
          .filter(([key]) => Boolean(key))
      ) as Record<string, {
        noFollowup?: boolean;
        autoLimit?: boolean;
        flowOnlyLoopLimit?: boolean;
        stickyProvider?: boolean;
        clientInjectOnly?: boolean;
        clearStateOnFollowupFailure?: boolean;
        seedLoopPayload?: boolean;
        retryEmptyFollowupOnce?: boolean;
        clientInjectSource?: string;
        transparentReplayRequestSuffix?: string;
        ignoreRequiresActionFollowup?: boolean;
        contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
      }>,
      noFollowupFlowIds: [],
      autoLimitFlowIds: [],
      flowOnlyLoopLimitFlowIds: [],
      stickyProviderFlowIds: [],
      clientInjectOnlyFlowIds: [],
      seedLoopPayloadFlowIds: [],
      retryEmptyFollowupOnceFlowIds: [],
      clientInjectSourceByFlowId: {},
      transparentReplayRequestSuffixByFlowId: {},
      ignoreRequiresActionFollowupFlowIds: [],
      contextDecorationModeByFlowId: {}
    }
  };
}

export function buildServertoolStateConfig(): {
  scopePriority: string[];
  pendingInjection: {
    enabled: boolean;
    strictContract: boolean;
  };
} {
  const skeleton = getDefaultServertoolSkeletonDocument();
  return {
    scopePriority: [...skeleton.servertool.state.scopePriority]
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter(Boolean),
    pendingInjection: {
      enabled: skeleton.servertool.state.pendingInjection.enabled !== false,
      strictContract: skeleton.servertool.state.pendingInjection.strictContract !== false
    }
  };
}

export function isServertoolEnabledByConfig(name: string): boolean {
  return getServertoolToolSpec(name)?.enabled !== false;
}
