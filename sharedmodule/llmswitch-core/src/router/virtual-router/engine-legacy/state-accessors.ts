import type { PreCommandStateSnapshot, RouterMetadataInput, StopMessageStateSnapshot, RoutePoolTier } from '../types.js';
import type { RoutingInstructionState } from '../routing-instructions.js';
import type { VirtualRouterEngine } from '../engine-legacy.js';
import { resolveStopMessageScope, getRoutingInstructionState, persistRoutingInstructionState } from '../engine/routing-state/store.js';
import { hasClientInjectScopedFields, stripClientInjectScopedFields } from './helpers.js';
import { flattenPoolTargets } from './route-utils.js';

export function getStopMessageState(
  engine: VirtualRouterEngine,
  metadata: RouterMetadataInput
): StopMessageStateSnapshot | null {
  const hasArmedStopState = (candidate: RoutingInstructionState | null): boolean => {
    if (!candidate) {
      return false;
    }
    const text = typeof candidate.stopMessageText === 'string' ? candidate.stopMessageText.trim() : '';
    const maxRepeats =
      typeof candidate.stopMessageMaxRepeats === 'number' && Number.isFinite(candidate.stopMessageMaxRepeats)
        ? Math.max(1, Math.floor(candidate.stopMessageMaxRepeats))
        : 0;
    const mode =
      typeof candidate.stopMessageStageMode === 'string'
        ? candidate.stopMessageStageMode.trim().toLowerCase()
        : '';
    if (mode === 'off') {
      return false;
    }
    return Boolean(text) && maxRepeats > 0;
  };

  const stopMessageScope = resolveStopMessageScope(metadata);
  if (!stopMessageScope) {
    const sessionScope = engine.resolveSessionScope(metadata);
    if (sessionScope) {
      const legacyState = getRoutingInstructionState(sessionScope, engine.routingInstructionState, engine.routingStateStore);
      if (hasClientInjectScopedFields(legacyState)) {
        const cleared = stripClientInjectScopedFields(legacyState);
        engine.routingInstructionState.set(sessionScope, cleared);
        persistRoutingInstructionState(sessionScope, cleared, engine.routingStateStore);
      }
    }
    return null;
  }

  const effectiveState = getRoutingInstructionState(
    stopMessageScope,
    engine.routingInstructionState,
    engine.routingStateStore
  );
  if (!hasArmedStopState(effectiveState)) {
    return null;
  }
  const text = typeof effectiveState.stopMessageText === 'string' ? effectiveState.stopMessageText.trim() : '';
  const maxRepeats =
    typeof effectiveState.stopMessageMaxRepeats === 'number' && Number.isFinite(effectiveState.stopMessageMaxRepeats)
      ? Math.max(1, Math.floor(effectiveState.stopMessageMaxRepeats))
      : 0;
  const stageModeRaw =
    typeof effectiveState.stopMessageStageMode === 'string'
      ? effectiveState.stopMessageStageMode.trim().toLowerCase()
      : '';
  const stageModeNormalized = stageModeRaw === 'on' || stageModeRaw === 'off' || stageModeRaw === 'auto'
    ? (stageModeRaw as 'on' | 'off' | 'auto')
    : undefined;
  const aiModeRaw =
    typeof effectiveState.stopMessageAiMode === 'string'
      ? effectiveState.stopMessageAiMode.trim().toLowerCase()
      : '';
  const aiModeNormalized = aiModeRaw === 'on' || aiModeRaw === 'off' ? (aiModeRaw as 'on' | 'off') : undefined;
  if (stageModeNormalized === 'off' || !text || maxRepeats <= 0) {
    return null;
  }
  return {
    ...(text ? { stopMessageText: text } : {}),
    stopMessageMaxRepeats: maxRepeats,
    ...(typeof effectiveState.stopMessageSource === 'string' && effectiveState.stopMessageSource.trim()
      ? { stopMessageSource: effectiveState.stopMessageSource.trim() }
      : {}),
    ...(typeof effectiveState.stopMessageUsed === 'number' && Number.isFinite(effectiveState.stopMessageUsed)
      ? { stopMessageUsed: Math.max(0, Math.floor(effectiveState.stopMessageUsed)) }
      : {}),
    ...(typeof effectiveState.stopMessageUpdatedAt === 'number' && Number.isFinite(effectiveState.stopMessageUpdatedAt)
      ? { stopMessageUpdatedAt: effectiveState.stopMessageUpdatedAt }
      : {}),
    ...(typeof effectiveState.stopMessageLastUsedAt === 'number' && Number.isFinite(effectiveState.stopMessageLastUsedAt)
      ? { stopMessageLastUsedAt: effectiveState.stopMessageLastUsedAt }
      : {}),
    ...(stageModeNormalized ? { stopMessageStageMode: stageModeNormalized } : {}),
    ...(aiModeNormalized ? { stopMessageAiMode: aiModeNormalized } : {}),
    ...(typeof effectiveState.stopMessageAiSeedPrompt === 'string' && effectiveState.stopMessageAiSeedPrompt.trim()
      ? { stopMessageAiSeedPrompt: effectiveState.stopMessageAiSeedPrompt.trim() }
      : {}),
    ...(Array.isArray(effectiveState.stopMessageAiHistory)
      ? { stopMessageAiHistory: effectiveState.stopMessageAiHistory }
      : {})
  };
}

export function getPreCommandState(
  engine: VirtualRouterEngine,
  metadata: RouterMetadataInput
): PreCommandStateSnapshot | null {
  const stopMessageScope = resolveStopMessageScope(metadata);
  if (!stopMessageScope) {
    return null;
  }
  const effectiveState = getRoutingInstructionState(
    stopMessageScope,
    engine.routingInstructionState,
    engine.routingStateStore
  );
  if (!effectiveState) {
    return null;
  }
  const scriptPath =
    typeof effectiveState.preCommandScriptPath === 'string' ? effectiveState.preCommandScriptPath.trim() : '';
  if (!scriptPath) {
    return null;
  }
  return {
    preCommandScriptPath: scriptPath,
    ...(typeof effectiveState.preCommandSource === 'string' && effectiveState.preCommandSource.trim()
      ? { preCommandSource: effectiveState.preCommandSource.trim() }
      : {}),
    ...(typeof effectiveState.preCommandUpdatedAt === 'number' && Number.isFinite(effectiveState.preCommandUpdatedAt)
      ? { preCommandUpdatedAt: effectiveState.preCommandUpdatedAt }
      : {})
  };
}

export function getStatus(engine: VirtualRouterEngine) {
  const routes: Record<
    string,
    {
      providers: string[];
      hits: number;
      lastUsedProvider?: string;
      lastHit?: {
        timestampMs: number;
        reason?: string;
        requestTokens?: number;
        selectionPenalty?: number;
        stopMessageActive: boolean;
        stopMessageMode?: 'on' | 'off' | 'auto';
        stopMessageRemaining?: number;
      };
    }
  > = {};
  for (const [route, pools] of Object.entries(engine.routing)) {
    const stats = engine.routeAnalytics.getRouteStats(route);
    routes[route] = {
      providers: flattenPoolTargets(engine, pools as RoutePoolTier[] | undefined),
      hits: stats?.hits ?? 0,
      lastUsedProvider: stats?.lastProvider,
      ...(stats?.lastHit ? { lastHit: { ...stats.lastHit } } : {})
    };
  }
  return {
    routes,
    health: engine.healthManager.getSnapshot()
  };
}
