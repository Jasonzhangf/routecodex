import { readRuntimeMetadata } from '../../../conversion/runtime-metadata.js';
import type { JsonObject } from '../../../conversion/hub/types/json.js';
import {
  getCapturedRequestWithNative,
  hasCompactionFlagWithNative,
  planStopMessageDefaultConfigWithNative,
  planStopMessagePersistSnapshotWithNative,
  planStopMessagePersistedLookupWithNative,
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
  resolveAdapterContextProviderKeyWithNative,
  resolveServertoolStateKeyWithNative,
  resolveStopMessageFollowupToolContentMaxCharsWithNative,
  resolveStopMessageFollowupProviderKeyWithNative,
  resolveStopMessageSessionScopeWithNative,
  resolveServertoolStickyKeyWithNative
} from '../../../native/router-hotpath/native-servertool-core-semantics.js';

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
  providerKey?: string;
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
  providerKey?: string;
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
  currentProviderKey?: string;
}): {
  compareMaxRepeats: number;
  compareRemaining: number;
  nextMaxRepeats: number;
  nextUsed: number;
  snapshot: {
    text: string;
    providerKey?: string;
    maxRepeats: number;
    used: number;
    source: string;
    stageMode: string;
    aiMode: 'off';
  };
} {
  return planStopMessagePersistSnapshotWithNative(args);
}

export function resolveAdapterContextProviderKey(adapterContext: unknown): string {
  return resolveAdapterContextProviderKeyWithNative(adapterContext);
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
  const responsesRequestContext =
    asRecord(record.responsesRequestContext)
    ?? asRecord(metadata?.responsesRequestContext)
    ?? asRecord(runtime?.responsesRequestContext);
  const sessionId =
    readNonEmptyString(record.sessionId)
    ?? readNonEmptyString(metadata?.sessionId)
    ?? readNonEmptyString(runtime?.sessionId);
  const conversationId =
    readNonEmptyString(record.conversationId)
    ?? readNonEmptyString(metadata?.conversationId)
    ?? readNonEmptyString(runtime?.conversationId);
  return {
    ...(metadata ?? {}),
    ...(runtime ?? {}),
    ...record,
    ...(responsesRequestContext ? { responsesRequestContext } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId ? { conversationId } : {})
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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
