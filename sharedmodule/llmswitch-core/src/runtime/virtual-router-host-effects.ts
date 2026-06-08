import type { ProcessedRequest, StandardizedRequest } from '../conversion/hub/types/standardized.js';
import type {
  RouterMetadataInput,
  RoutingDecision,
  StopMessageStateSnapshot,
  TargetMetadata
} from '../native/router-hotpath/virtual-router-contracts.js';
import { resolveRccUserDir } from './user-data-paths.js';
import {
  resolveStopMessageScope,
} from '../router/virtual-router/engine/routing-state/store.js';
import { resolveRouteColor, resolveSessionColor } from './virtual-router-hit-log.js';
import { loadRoutingInstructionStateSync, saveRoutingInstructionStateSync } from '../router/virtual-router/routing-state-store.js';
import type { RoutingInstructionState } from '../router/virtual-router/routing-instructions.js';
import { mergeStopMessageFromPersisted } from '../router/virtual-router/stop-message-state-sync.js';
import {
  buildStopMessageMarkerParseLog,
  cleanStopMessageMarkersInPlace,
  emitStopMessageMarkerParseLog,
  formatStopMessageStatusLabel
} from '../router/virtual-router/stop-message-markers.js';

export type VirtualRouterRouteHostEffects = {
  finalize: (
    result: { target: TargetMetadata; decision: RoutingDecision },
    getStopMessageState: (metadata: RouterMetadataInput) => StopMessageStateSnapshot | null
  ) => void;
};

export function createVirtualRouterRouteHostEffects(args: {
  request: StandardizedRequest | ProcessedRequest | Record<string, unknown>;
  metadata: RouterMetadataInput | Record<string, unknown>;
}): VirtualRouterRouteHostEffects {
  const metadata = coerceRouterMetadata(args.metadata);
  const parseLog = buildStopMessageMarkerParseLog(args.request as StandardizedRequest | ProcessedRequest, metadata);
  return {
    finalize: (result, getStopMessageState) => {
      emitStopMessageMarkerParseLog(parseLog);
      cleanStopMessageMarkersInPlace(args.request as Record<string, unknown>);
      const stopScope = parseLog?.stopScope || resolveStopMessageScope(metadata);
      const stopState = stopScope ? getStopMessageState(metadata) : null;
      const forceStopStatusLabel = Boolean(
        parseLog?.stopMessageTypes.length ||
        parseLog?.scopedTypes.some((type) => type === 'stopMessageSet' || type === 'stopMessageMode' || type === 'stopMessageClear')
      );
      if ((metadata as { __rt?: Record<string, unknown> }).__rt?.disableVirtualRouterHitLog !== true) {
        emitVirtualRouterHitLog(result, {
          requestId: resolveVirtualRouterLogRequestId(metadata),
          sessionId: resolveVirtualRouterLogSessionId(metadata),
          stopScope,
          stopState,
          forceStopStatusLabel
        });
      }
    }
  };
}

export function resolveTmuxScopedVirtualRouterStateScope(
  metadata: RouterMetadataInput | Record<string, unknown>
): string | null {
  const metadataInput = coerceRouterMetadata(metadata);
  const scope = resolveStopMessageScope(metadataInput);
  if (!isTmuxScopedStopMessageState(scope)) {
    pruneLegacySessionScopedStopAndPreCommandState(metadataInput);
    return null;
  }
  return scope;
}

export function mergeVirtualRouterStopMessageSnapshotWithPersisted(
  snapshot: StopMessageStateSnapshot | null,
  scope?: string
): StopMessageStateSnapshot | null {
  if (!scope) {
    return snapshot;
  }
  let persisted: RoutingInstructionState | null = null;
  try {
    persisted = loadRoutingInstructionStateSync(scope) as RoutingInstructionState | null;
  } catch {
    return snapshot;
  }
  if (!persisted) {
    return snapshot;
  }
  const persistedText =
    typeof persisted.stopMessageText === 'string' ? persisted.stopMessageText.trim() : '';
  if (!snapshot && !persistedText) {
    return snapshot;
  }

  const existing = {
    stopMessageSource: snapshot?.stopMessageSource,
    stopMessageText: snapshot?.stopMessageText,
    stopMessageMaxRepeats: snapshot?.stopMessageMaxRepeats,
    stopMessageUsed: snapshot?.stopMessageUsed,
    stopMessageUpdatedAt: snapshot?.stopMessageUpdatedAt,
    stopMessageLastUsedAt: snapshot?.stopMessageLastUsedAt,
    stopMessageStageMode: snapshot?.stopMessageStageMode,
    stopMessageAiMode: snapshot?.stopMessageAiMode,
    stopMessageAiSeedPrompt: snapshot?.stopMessageAiSeedPrompt,
    stopMessageAiHistory: snapshot?.stopMessageAiHistory
  };
  const merged = mergeStopMessageFromPersisted(existing, persisted);
  const base: StopMessageStateSnapshot = snapshot ?? {
    stopMessageMaxRepeats:
      typeof merged.stopMessageMaxRepeats === 'number' && Number.isFinite(merged.stopMessageMaxRepeats)
        ? merged.stopMessageMaxRepeats
        : 0
  };
  const mergedMaxRepeats =
    typeof merged.stopMessageMaxRepeats === 'number' && Number.isFinite(merged.stopMessageMaxRepeats)
      ? merged.stopMessageMaxRepeats
      : base.stopMessageMaxRepeats;

  return {
    ...base,
    stopMessageSource: merged.stopMessageSource,
    stopMessageText: merged.stopMessageText,
    stopMessageMaxRepeats: mergedMaxRepeats,
    stopMessageUsed: merged.stopMessageUsed,
    stopMessageUpdatedAt: merged.stopMessageUpdatedAt,
    stopMessageLastUsedAt: merged.stopMessageLastUsedAt,
    stopMessageStageMode: merged.stopMessageStageMode,
    stopMessageAiMode: merged.stopMessageAiMode,
    stopMessageAiSeedPrompt: merged.stopMessageAiSeedPrompt,
    stopMessageAiHistory: merged.stopMessageAiHistory
  };
}

export function injectVirtualRouterRuntimeMetadata(
  metadata: RouterMetadataInput | Record<string, unknown>
): Record<string, unknown> {
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const nowMs = Date.now();
  const rt = metadataRecord.__rt;
  const existingRt = rt && typeof rt === 'object' && !Array.isArray(rt)
    ? (rt as Record<string, unknown>)
    : undefined;
  const runtimeOverrides: Record<string, unknown> = { nowMs };

  const hasSessionDir = typeof existingRt?.sessionDir === 'string' && existingRt.sessionDir.trim().length > 0;
  if (!hasSessionDir) {
    const sessionDir = String(process.env.ROUTECODEX_SESSION_DIR || '').trim();
    if (sessionDir) {
      runtimeOverrides.sessionDir = sessionDir;
    }
  }

  const hasRccUserDir = typeof existingRt?.rccUserDir === 'string' && existingRt.rccUserDir.trim().length > 0;
  if (!hasRccUserDir) {
    const rccUserDir = resolveRccUserDir();
    if (rccUserDir) {
      runtimeOverrides.rccUserDir = rccUserDir;
    }
  }

  return {
    ...metadataRecord,
    __rt: { ...(existingRt ?? {}), ...runtimeOverrides }
  };
}

function coerceRouterMetadata(metadata: RouterMetadataInput | Record<string, unknown>): RouterMetadataInput {
  return (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {}) as RouterMetadataInput;
}

function isTmuxScopedStopMessageState(scope: string | undefined): boolean {
  return typeof scope === 'string' && scope.startsWith('tmux:');
}

function pruneLegacySessionScopedStopAndPreCommandState(metadata: RouterMetadataInput): void {
  const sessionId = typeof metadata.sessionId === 'string' ? metadata.sessionId.trim() : '';
  if (!sessionId) {
    return;
  }
  const legacyKey = `session:${sessionId}`;
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(legacyKey) as RoutingInstructionState | null;
  } catch {
    return;
  }
  if (!state) {
    return;
  }
  state.stopMessageSource = undefined;
  state.stopMessageText = undefined;
  state.stopMessageMaxRepeats = undefined;
  state.stopMessageUsed = undefined;
  state.stopMessageUpdatedAt = undefined;
  state.stopMessageLastUsedAt = undefined;
  state.stopMessageStageMode = undefined;
  state.stopMessageAiMode = undefined;
  state.stopMessageAiSeedPrompt = undefined;
  state.stopMessageAiHistory = undefined;
  state.preCommandSource = undefined;
  state.preCommandScriptPath = undefined;
  state.preCommandUpdatedAt = undefined;

  const hasOtherRoutingState =
    Boolean(state.stoplessGoalState) ||
    Boolean(state.forcedTarget) ||
    Boolean(state.preferTarget) ||
    state.allowedProviders.size > 0 ||
    state.disabledProviders.size > 0 ||
    state.disabledKeys.size > 0 ||
    state.disabledModels.size > 0;

  saveRoutingInstructionStateSync(legacyKey, hasOtherRoutingState ? state : null);
}

function emitVirtualRouterHitLog(result: {
  target: TargetMetadata;
  decision: RoutingDecision;
}, options?: {
  requestId?: string;
  sessionId?: string;
  stopScope?: string;
  stopState?: StopMessageStateSnapshot | null;
  forceStopStatusLabel?: boolean;
}): void {
  const reset = '\x1b[0m';
  const prefixColor = '\x1b[38;5;208m';
  const timeColor = '\x1b[90m';
  const stopColor = '\x1b[38;5;214m';
  const now = new Date();
  const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const routeLabel = result.decision.poolId
    ? `${result.decision.routeName}/${result.decision.poolId}`
    : result.decision.routeName;
  const routeColor = resolveSessionColor(options?.sessionId) || resolveRouteColor(result.decision.routeName);
  const providerKey = result.decision.providerKey || result.target.providerKey;
  const modelSuffix = result.target.modelId ? `.${result.target.modelId}` : '';
  const reason = result.decision.reasoning ? ` reason=${result.decision.reasoning}` : '';
  const stopStatusLabel = formatStopMessageStatusLabel(
    options?.stopState ?? null,
    options?.stopScope,
    Boolean(options?.forceStopStatusLabel)
  );
  const requestId = typeof options?.requestId === 'string' ? options.requestId : '';
  const requestLabel = requestId && !requestId.includes('unknown') ? ` req=${requestId}` : '';
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  const sessionLabel = sessionId ? ` sid=${sessionId}` : '';
  console.log(
    `${prefixColor}[virtual-router-hit]${reset} ${timeColor}${timestamp}${reset}${requestLabel}${sessionLabel} ${routeColor}${routeLabel} -> ${providerKey}${modelSuffix}${reason}${reset}${stopStatusLabel ? ` ${stopColor}${stopStatusLabel}${reset}` : ''}`
  );
}

function resolveVirtualRouterLogRequestId(metadata: RouterMetadataInput): string | undefined {
  const metadataRecord = metadata as unknown as Record<string, unknown>;
  const candidates = [
    metadata.requestId,
    metadataRecord.clientRequestId,
    metadataRecord.inputRequestId,
    metadataRecord.groupRequestId
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() && !value.includes('unknown')) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveVirtualRouterLogSessionId(metadata: RouterMetadataInput): string | undefined {
  const candidates = [
    metadata.sessionId,
    metadata.clientTmuxSessionId,
    metadata.client_tmux_session_id,
    metadata.tmuxSessionId,
    metadata.tmux_session_id,
    metadata.conversationId
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
