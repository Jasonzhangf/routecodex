/**
 * State Integrations Bridge
 *
 * Routing state, session identifier extraction, stats center, and
 * clock task store compatibility wrappers.
 */

import { requireCoreDist } from './module-loader.js';
import type { AnyRecord } from './module-loader.js';
import { formatUnknownError } from '../../../utils/common-utils.js';

type RoutingInstructionState = Record<string, unknown>;

function buildStateIntegrationFailure(stage: string, error: unknown, details?: Record<string, unknown>): Error {
  const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
  const message = `[llmswitch-bridge.state-integrations] ${stage} failed: ${formatUnknownError(error)}${detailSuffix}`;
  const wrapped = new Error(message);
  Object.assign(wrapped, {
    code: 'STATE_INTEGRATION_FAILED',
    stage,
    details,
    cause: error
  });
  return wrapped;
}

export function loadRoutingInstructionStateSync(key: string): unknown | null {
  try {
    const mod = requireCoreDist<{ loadRoutingInstructionStateSync?: (k: string) => unknown | null }>('native/router-hotpath/native-virtual-router-routing-state');
    const fn = mod.loadRoutingInstructionStateSync;
    if (typeof fn !== 'function') {
      throw new Error('loadRoutingInstructionStateSync native unavailable');
    }
    return fn(key);
  } catch (error) {
    throw buildStateIntegrationFailure('routing_state_store.load_state.invoke', error, { key });
  }
}

export function saveRoutingInstructionStateAsync(key: string, state: unknown | null): void {
  try {
    const mod = requireCoreDist<{ saveRoutingInstructionStateAsync?: (k: string, s: unknown | null) => void }>('native/router-hotpath/native-virtual-router-routing-state');
    const fn = mod.saveRoutingInstructionStateAsync;
    if (typeof fn !== 'function') {
      throw new Error('saveRoutingInstructionStateAsync native unavailable');
    }
    fn(key, state);
  } catch (error) {
    throw buildStateIntegrationFailure('routing_state_store.save_async.invoke', error, { key });
  }
}

export function saveRoutingInstructionStateSync(key: string, state: unknown | null): void {
  try {
    const mod = requireCoreDist<{ saveRoutingInstructionStateSync?: (k: string, s: unknown | null) => void }>('native/router-hotpath/native-virtual-router-routing-state');
    const fn = mod.saveRoutingInstructionStateSync;
    if (typeof fn !== 'function') {
      throw new Error('saveRoutingInstructionStateSync native unavailable');
    }
    fn(key, state);
  } catch (error) {
    throw buildStateIntegrationFailure('routing_state_store.save_sync.invoke', error, { key });
  }
}

export function syncStoplessGoalStateFromRequest(adapterContext: unknown): unknown {
  try {
    const mod = requireCoreDist<{ syncStoplessGoalStateFromRequest?: (adapterContext: unknown) => unknown }>('servertool/handlers/stopless-goal-state');
    const fn = mod.syncStoplessGoalStateFromRequest;
    if (typeof fn !== 'function') {
      throw new Error('syncStoplessGoalStateFromRequest native unavailable');
    }
    return fn(adapterContext);
  } catch (error) {
    throw buildStateIntegrationFailure('stopless_goal_state.sync.invoke', error);
  }
}

export function persistStoplessGoalStateSnapshot(adapterContext: unknown, state: unknown): unknown {
  try {
    const mod = requireCoreDist<{ persistStoplessGoalStateSnapshot?: (adapterContext: unknown, state: unknown) => unknown }>('servertool/handlers/stopless-goal-state');
    const fn = mod.persistStoplessGoalStateSnapshot;
    if (typeof fn !== 'function') {
      throw new Error('persistStoplessGoalStateSnapshot native unavailable');
    }
    return fn(adapterContext, state);
  } catch (error) {
    throw buildStateIntegrationFailure('stopless_goal_state.persist.invoke', error);
  }
}

export function readStoplessGoalState(adapterContext: unknown): unknown {
  try {
    const mod = requireCoreDist<{ readStoplessGoalState?: (adapterContext: unknown) => unknown }>('servertool/handlers/stopless-goal-state');
    const fn = mod.readStoplessGoalState;
    if (typeof fn !== 'function') {
      throw new Error('readStoplessGoalState native unavailable');
    }
    return fn(adapterContext);
  } catch (error) {
    throw buildStateIntegrationFailure('stopless_goal_state.read.invoke', error);
  }
}

type SessionIdentifiers = { sessionId?: string; conversationId?: string };

function readNormalizedMetadataToken(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

export function extractSessionIdentifiersFromMetadata(meta: Record<string, unknown> | undefined): SessionIdentifiers {
  try {
    const sessionId = readNormalizedMetadataToken(meta, [
      'sessionId',
      'session_id',
      'tmuxSessionId',
      'clientTmuxSessionId'
    ]);
    const conversationId = readNormalizedMetadataToken(meta, [
      'conversationId',
      'conversation_id'
    ]);
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(conversationId ? { conversationId } : {})
    };
  } catch (error) {
    throw buildStateIntegrationFailure('session_identifiers.extract.invoke', error);
  }
}

type StatsCenterLike = {
  recordProviderUsage(ev: unknown): void;
};

type StatsCenterModule = {
  getStatsCenter?: () => StatsCenterLike;
};

let cachedStatsCenter: StatsCenterLike | null | undefined = undefined;

export function getStatsCenterSafe(): StatsCenterLike {
  if (cachedStatsCenter) {
    return cachedStatsCenter;
  }
  if (cachedStatsCenter === null) {
    throw buildStateIntegrationFailure('stats_center.load.cached_unavailable', 'stats center unavailable');
  }
  try {
    const mod = requireCoreDist<StatsCenterModule>('telemetry/stats-center');
    const fn = mod?.getStatsCenter;
    const center = typeof fn === 'function' ? fn() : null;
    if (center && typeof center.recordProviderUsage === 'function') {
      cachedStatsCenter = center;
      return center;
    }
    throw buildStateIntegrationFailure('stats_center.api_unavailable', 'getStatsCenter not available');
  } catch (error) {
    cachedStatsCenter = null;
    throw buildStateIntegrationFailure('stats_center.load', error);
  }
}

export function getLlmsStatsSnapshot(): unknown | null {
  try {
    const mod = requireCoreDist<{ getStatsCenter?: () => { getSnapshot?: () => unknown } }>('telemetry/stats-center');
    const get = mod?.getStatsCenter;
    const center = typeof get === 'function' ? get() : null;
    const snap = center && typeof center === 'object' ? (center as any).getSnapshot : null;
    if (typeof snap !== 'function') {
      throw buildStateIntegrationFailure('stats_center.snapshot.api_unavailable', 'getSnapshot not available');
    }
    return snap.call(center);
  } catch (error) {
    throw buildStateIntegrationFailure('stats_center.snapshot.invoke', error);
  }
}
