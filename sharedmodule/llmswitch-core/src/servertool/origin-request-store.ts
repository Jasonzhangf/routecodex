/**
 * origin-request-store.ts
 *
 * Persists origin request snapshots by session scope.
 * Followup re-enter requests load the origin snapshot from this store
 * rather than relying on in-memory adapterContext across process boundaries.
 *
 * Design doc: docs/design/servertool-followup-rebuild-from-origin.md
 * Phase 1: in-memory adapterContext as source (capturedChatRequest)
 * Phase 2+: persistent tmux/file store for cross-process survival
 */

import type { JsonObject } from '../conversion/hub/types/json.js';

export type OriginSnapshot = {
  model?: string;
  messages: JsonObject[];
  tools?: JsonObject[];
  parameters?: JsonObject;
  entryEndpoint?: string;
  providerProtocol?: string;
  requestId: string;
  sessionScope: string;
  savedAt: number;
};

// In-memory store (Phase 1); tmux/file persistence follows in Phase 2
const snapshotStore = new Map<string, OriginSnapshot>();

/**
 * Save an origin request snapshot by session scope.
 * Returns false if session scope is invalid (fail-fast per no-fallback policy).
 */
export function saveOriginSnapshot(
  sessionScope: string,
  snapshot: Omit<OriginSnapshot, 'savedAt'>
): boolean {
  if (!sessionScope || typeof sessionScope !== 'string' || !sessionScope.trim()) {
    return false;
  }
  const key = sessionScope.trim();
  snapshotStore.set(key, {
    ...snapshot,
    sessionScope: key,
    savedAt: Date.now()
  });
  return true;
}

/**
 * Load an origin request snapshot by session scope.
 * Returns undefined if not found.
 */
export function loadOriginSnapshot(sessionScope: string): OriginSnapshot | undefined {
  if (!sessionScope || typeof sessionScope !== 'string' || !sessionScope.trim()) {
    return undefined;
  }
  return snapshotStore.get(sessionScope.trim());
}

/**
 * Check if origin snapshot exists for a given session scope.
 */
export function hasOriginSnapshot(sessionScope: string): boolean {
  if (!sessionScope || typeof sessionScope !== 'string' || !sessionScope.trim()) {
    return false;
  }
  return snapshotStore.has(sessionScope.trim());
}

/**
 * Remove a snapshot after it has been consumed (prevents stale re-use).
 */
export function clearOriginSnapshot(sessionScope: string): void {
  if (!sessionScope || typeof sessionScope !== 'string' || !sessionScope.trim()) {
    return;
  }
  snapshotStore.delete(sessionScope.trim());
}
