import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { RoutingInstructionState } from '../router/virtual-router/routing-instructions.js';
import {
  deserializeRoutingInstructionState,
  serializeRoutingInstructionState
} from '../router/virtual-router/routing-instructions.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../router/virtual-router/sticky-session-store.js';
import { clearStopMessageState, createStopMessageState, resolveStopMessageSnapshot } from './handlers/stop-message-auto/routing-state.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';

export { createStopMessageState, resolveStopMessageSnapshot };

export function cloneRoutingInstructionState(
  state: RoutingInstructionState | null,
  logNonBlocking: (stage: string, error: unknown) => void
): RoutingInstructionState | null {
  if (!state) {
    return null;
  }
  try {
    const serialized = serializeRoutingInstructionState(state);
    return deserializeRoutingInstructionState(serialized);
  } catch (error) {
    logNonBlocking('clone_routing_instruction_state', error);
    return null;
  }
}

export function isAdapterClientDisconnected(adapterContext: AdapterContext): boolean {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return false;
  }
  const state = (adapterContext as { clientConnectionState?: unknown }).clientConnectionState;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const disconnected = (state as { disconnected?: unknown }).disconnected;
    if (disconnected === true) {
      return true;
    }
    if (typeof disconnected === 'string' && disconnected.trim().toLowerCase() === 'true') {
      return true;
    }
  }
  const raw = (adapterContext as { clientDisconnected?: unknown }).clientDisconnected;
  if (raw === true) {
    return true;
  }
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

export function disableStopMessageAfterFailedFollowup(args: {
  adapterContext: AdapterContext;
  reservation: { stickyKey: string; previousState: Record<string, unknown> | null } | null;
  logNonBlocking: (stage: string, error: unknown) => void;
}): void {
  try {
    const key =
      args.reservation && typeof args.reservation.stickyKey === 'string' && args.reservation.stickyKey.trim()
        ? args.reservation.stickyKey.trim()
        : resolveServertoolPersistentScopeKey(args.adapterContext);
    if (!key) {
      return;
    }
    const state = loadRoutingInstructionStateSync(key);
    if (!state) {
      return;
    }
    clearStopMessageState(state, Date.now());
    state.stopMessageLastUsedAt = Date.now();
    saveRoutingInstructionStateSync(key, state);
  } catch (error) {
    args.logNonBlocking('disable_stop_message_after_failed_followup', error);
  }
}
