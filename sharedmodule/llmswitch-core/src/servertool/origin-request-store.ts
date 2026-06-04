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
  capturedEntryRequest?: JsonObject;
  capturedChatRequest?: JsonObject;
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
const MAX_ORIGIN_SNAPSHOTS = 512;
const ORIGIN_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

function pruneExpiredSnapshots(now = Date.now()): void {
  for (const [key, snapshot] of snapshotStore.entries()) {
    if (!snapshot || !Number.isFinite(snapshot.savedAt) || now - snapshot.savedAt > ORIGIN_SNAPSHOT_TTL_MS) {
      snapshotStore.delete(key);
    }
  }
}

function trimSnapshotStoreToCapacity(): void {
  if (snapshotStore.size <= MAX_ORIGIN_SNAPSHOTS) {
    return;
  }
  const entries = [...snapshotStore.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
  const deleteCount = Math.max(0, entries.length - MAX_ORIGIN_SNAPSHOTS);
  for (let i = 0; i < deleteCount; i += 1) {
    snapshotStore.delete(entries[i][0]);
  }
}

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
  pruneExpiredSnapshots();
  snapshotStore.set(key, {
    ...snapshot,
    sessionScope: key,
    savedAt: Date.now()
  });
  trimSnapshotStoreToCapacity();
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
  pruneExpiredSnapshots();
  return snapshotStore.get(sessionScope.trim());
}

/**
 * Check if origin snapshot exists for a given session scope.
 */
export function hasOriginSnapshot(sessionScope: string): boolean {
  if (!sessionScope || typeof sessionScope !== 'string' || !sessionScope.trim()) {
    return false;
  }
  pruneExpiredSnapshots();
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
