import type { JsonObject } from '../../../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../../../conversion/runtime-metadata.js';
import {
  getCapturedRequestWithNative,
  hasCompactionFlagWithNative,
  planPersistStopMessageStateWithNative,
  planStopMessageDefaultConfigWithNative,
  planStopMessagePersistSnapshotWithNative,
  planStopMessagePersistedLookupWithNative,
  planStopMessagePersistedStateSelectionWithNative,
  planStoplessDecisionContextGoalStatusWithNative,
  planStoplessDecisionContextSignalsWithNative,
  readRuntimeStopMessageStageModeWithNative,
  readServertoolFollowupFlowIdWithNative,
  resolveBdWorkingDirectoryForRecordWithNative,
  resolveClientConnectionStateWithNative,
  resolveDefaultStopMessageSnapshotWithNative,
  resolveEntryEndpointWithNative,
  resolveImplicitGeminiStopMessageSnapshotWithNative,
  resolveRuntimeStopMessageStateFromAdapterContextWithNative,
  resolveRuntimeStopMessageStateWithNative,
  resolveServertoolStateKeyWithNative,
  resolveStopMessageFollowupToolContentMaxCharsWithNative,
  resolveStopMessageFollowupProviderKeyWithNative,
  resolveStopMessageSessionScopeWithNative,
  resolveServertoolStickyKeyWithNative
} from '../../../native/router-hotpath/native-servertool-core-semantics.js';
import type { RoutingInstructionState } from '../../../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../../native/router-hotpath/native-virtual-router-routing-state.js';

export function resolveStickyKey(
  record: {
    requestId?: unknown;
    providerProtocol?: unknown;
    continuation?: unknown;
    responsesResume?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown
): string | undefined {
  return resolveServertoolStickyKeyWithNative(buildServertoolRoutingMetadata(record, runtimeMetadata)) || undefined;
}

export function resolveStateKey(
  record: {
    requestId?: unknown;
    providerProtocol?: unknown;
    continuation?: unknown;
    responsesResume?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown
): string {
  return resolveServertoolStateKeyWithNative(buildServertoolRoutingMetadata(record, runtimeMetadata));
}

export function planStopMessagePersistedLookup(
  record: {
    tmuxSessionId?: unknown;
    clientTmuxSessionId?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown,
  options?: {
    includeSnapshotLookup?: boolean;
    includeTombstoneLookup?: boolean;
  }
): {
  strictSessionScope?: string | null;
  stickyKey?: string | null;
  candidateKeys: string[];
  lookupPolicy: string;
  readStopMessageSnapshot: boolean;
  readStopMessageTombstone: boolean;
} {
  return planStopMessagePersistedLookupWithNative({
    record: buildServertoolRoutingMetadata(record, runtimeMetadata),
    runtimeMetadata: asRecord(runtimeMetadata) ?? undefined,
    options
  });
}

export function planStopMessagePersistedStateSelection(candidateKeys: string[]): {
  snapshot?: {
    text: string;
    maxRepeats: number;
    used: number;
    source?: string;
    updatedAt?: number;
    lastUsedAt?: number;
    stageMode?: 'on' | 'off' | 'auto';
    aiMode?: 'on' | 'off';
  };
  stageMode?: 'on' | 'off' | 'auto';
  tombstone: {
    exhaustedDefault: boolean;
    cleared: boolean;
  };
} {
  return planStopMessagePersistedStateSelectionWithNative({
    states: candidateKeys.map((key) => ({
      key,
      state: loadRoutingInstructionStateSync(key) ?? null
    }))
  });
}

export function persistStopMessageState(stickyKey: string | undefined, state: RoutingInstructionState): void {
  const plan = planPersistStopMessageStateWithNative({
    state: buildPersistableRoutingInstructionState(state)
  });
  saveRoutingInstructionStateSync(stickyKey, plan.action === 'clear' ? null : state);
}

export function resolveStopMessageSessionScope(
  record: {
    sessionId?: unknown;
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown
): string | undefined {
  return resolveStopMessageSessionScopeWithNative(buildServertoolRoutingMetadata(record, runtimeMetadata)) || undefined;
}

export function resolveRuntimeStopMessageState(runtimeMetadata: unknown): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
} | null {
  return resolveRuntimeStopMessageStateWithNative(runtimeMetadata);
}

export function resolveRuntimeStopMessageStateFromAdapterContext(adapterContext: unknown): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
} | null {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return null;
  }
  const runtime = readRuntimeMetadata(adapterContext as Record<string, unknown>);
  return resolveRuntimeStopMessageStateFromAdapterContextWithNative({
    adapterContext,
    runtimeMetadata: runtime
  });
}

export function readRuntimeStopMessageStageMode(runtimeMetadata: unknown): 'on' | 'off' | 'auto' | undefined {
  return readRuntimeStopMessageStageModeWithNative(runtimeMetadata);
}

export function planStoplessDecisionContextSignals(args: {
  adapterContext: unknown;
  runtimeMetadata?: unknown;
  capturedRequest?: unknown;
}): {
  portStopMessageDisabled: boolean;
  hasResponsesSubmitToolOutputsResume: boolean;
  planModeActive: boolean;
} {
  return planStoplessDecisionContextSignalsWithNative(args);
}

export function planStoplessDecisionContextGoalStatus(args: {
  adapterContext: unknown;
  persistedGoalState?: unknown;
}): {
  goalStatus: string;
  hasRequestScopedGoalState: boolean;
} {
  return planStoplessDecisionContextGoalStatusWithNative(args);
}

export function planStopMessageDefaultConfig(args: {
  tombstoneCleared?: boolean;
  configEnabled?: unknown;
  configText?: unknown;
  configMaxRepeats?: unknown;
  envText?: unknown;
  envMaxRepeats?: unknown;
}): {
  enabled: boolean;
  text: string;
  maxRepeats: number;
} {
  return planStopMessageDefaultConfigWithNative(args);
}

export function planStopMessagePersistSnapshot(args: {
  schemaGate: unknown;
  decision: unknown;
  stateUpdate?: unknown;
  defaultText?: string;
  schemaUsedBeforeCount?: unknown;
}): {
  compareMaxRepeats: number;
  compareRemaining: number;
  nextMaxRepeats: number;
  nextUsed: number;
  snapshot: {
    text: string;
    maxRepeats: number;
    used: number;
    source: string;
    stageMode: string;
    aiMode: 'off';
  };
} {
  return planStopMessagePersistSnapshotWithNative(args);
}

function buildServertoolRoutingMetadata(
  record: {
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown
): Record<string, unknown> {
  const metadata = asRecord(record.metadata);
  const runtime = asRecord(runtimeMetadata);
  return {
    ...(metadata ?? {}),
    ...(runtime ?? {}),
    ...record
  };
}

function buildPersistableRoutingInstructionState(state: RoutingInstructionState): Record<string, unknown> {
  return {
    ...state,
    allowedProviders: Array.from(state.allowedProviders ?? []),
    disabledProviders: Array.from(state.disabledProviders ?? []),
    disabledKeys: Array.from(state.disabledKeys ?? new Map()).map(([provider, keys]) => ({
      provider,
      keys: Array.from(keys)
    })),
    disabledModels: Array.from(state.disabledModels ?? new Map()).map(([provider, models]) => ({
      provider,
      models: Array.from(models)
    }))
  };
}

export function resolveBdWorkingDirectoryForRecord(
  record: {
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata: unknown
): string | undefined {
  return resolveBdWorkingDirectoryForRecordWithNative({
    record,
    runtimeMetadata
  });
}

export function readServerToolFollowupFlowId(runtimeMetadata: unknown): string {
  return readServertoolFollowupFlowIdWithNative(runtimeMetadata);
}

export function resolveStopMessageFollowupProviderKey(args: {
  record: {
    providerKey?: unknown;
    providerId?: unknown;
    metadata?: unknown;
  };
  runtimeMetadata?: unknown;
}): string {
  return resolveStopMessageFollowupProviderKeyWithNative({
    record: args.record,
    runtimeMetadata: args.runtimeMetadata
  });
}

export function resolveStopMessageFollowupToolContentMaxChars(params: {
  providerKey?: string;
  model?: string;
}): number | undefined {
  return resolveStopMessageFollowupToolContentMaxCharsWithNative({
    envValue: process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS,
    providerKey: params.providerKey,
    model: params.model
  });
}

export function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  return getCapturedRequestWithNative(adapterContext) as JsonObject | null;
}

export function resolveClientConnectionState(value: unknown): { disconnected?: boolean } | null {
  return resolveClientConnectionStateWithNative(value);
}

export function hasCompactionFlag(rt: unknown): boolean {
  return hasCompactionFlagWithNative(rt);
}

export function resolveImplicitGeminiStopMessageSnapshot(
  ctx: {
    base: unknown;
    adapterContext: unknown;
    providerProtocol?: string;
  },
  record: {
    providerProtocol?: unknown;
    entryEndpoint?: unknown;
    metadata?: unknown;
  }
): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
} | null {
  return resolveImplicitGeminiStopMessageSnapshotWithNative({
    base: ctx.base,
    adapterContext: ctx.adapterContext,
    providerProtocol: ctx.providerProtocol,
    record: record as Record<string, unknown>
  });
}

export function resolveDefaultStopMessageSnapshot(
  ctx: {
    base: unknown;
    adapterContext: unknown;
  },
  options?: {
    text?: string;
    maxRepeats?: number;
  }
): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
} | null {
  return resolveDefaultStopMessageSnapshotWithNative({
    base: ctx.base,
    adapterContext: ctx.adapterContext,
    options
  });
}

export function resolveEntryEndpoint(record: Record<string, unknown>): string {
  return resolveEntryEndpointWithNative(record);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
