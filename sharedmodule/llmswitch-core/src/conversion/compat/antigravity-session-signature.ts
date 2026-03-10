import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  cacheAntigravitySessionSignatureWithNative,
  getAntigravityRequestSessionMetaWithNative,
  resetAntigravitySignatureCachesWithNative
} from '../../router/virtual-router/engine-selection/native-router-hotpath.js';

type UnknownRecord = Record<string, unknown>;

const DUMMY_THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';

// Antigravity-Manager alignment:
// - session_id has no time limit (continuity across long conversations / restarts)
// - signature cache is bounded by size, not by time
// Time-based expiry is disabled when SIGNATURE_TTL_MS <= 0.
const SIGNATURE_TTL_MS = 0;
// Still "touch" active sessions to refresh persisted timestamps / LRU ordering,
// but avoid excessive disk churn.
const SIGNATURE_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_SIGNATURE_LENGTH = 50;
const SESSION_CACHE_LIMIT = 1000;
// Keep rewind guard finite to avoid reusing stale signatures after a rewind.
const REWIND_BLOCK_MS = 2 * 60 * 60 * 1000;

type SessionSignatureEntry = {
  signature: string;
  messageCount: number;
  timestamp: number;
};

type LatestSignatureEntry = {
  signature: string;
  messageCount: number;
  timestamp: number;
  sessionId?: string;
};

type PinnedAliasEntry = {
  aliasKey: string;
  timestamp: number;
};

type PinnedSessionEntry = {
  sessionId: string;
  timestamp: number;
};

type PersistenceConfig = {
  stateDir: string;
  fileName: string;
};

type PersistenceState = {
  config: PersistenceConfig;
  loadedMtimeMs: number | null;
  loadedOnce: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

const GLOBAL_PERSISTENCE_KEY = '__LLMSWITCH_ANTIGRAVITY_SESSION_SIGNATURE_PERSISTENCE__';

function getPersistenceState(): PersistenceState | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[GLOBAL_PERSISTENCE_KEY];
  if (existing && typeof existing === 'object') {
    return existing as PersistenceState;
  }
  return null;
}

function setPersistenceState(state: PersistenceState | null): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!state) {
    delete g[GLOBAL_PERSISTENCE_KEY];
    return;
  }
  g[GLOBAL_PERSISTENCE_KEY] = state;
}

export function configureAntigravitySessionSignaturePersistence(
  input:
    | {
        stateDir: string;
        fileName?: string;
      }
    | null
): void {
  if (!input) {
    const prior = getPersistenceState();
    if (prior?.flushTimer) {
      clearTimeout(prior.flushTimer);
    }
    setPersistenceState(null);
    try {
      delete process.env.ROUTECODEX_ANTIGRAVITY_SIGNATURE_STATE_DIR;
      delete process.env.ROUTECODEX_ANTIGRAVITY_SIGNATURE_FILE;
    } catch {
      // best-effort only
    }
    return;
  }
  const stateDir = typeof input.stateDir === 'string' ? input.stateDir.trim() : '';
  if (!stateDir) {
    setPersistenceState(null);
    return;
  }
  const fileName = typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.trim() : 'antigravity-session-signatures.json';
  const prior = getPersistenceState();
  if (prior?.flushTimer) {
    clearTimeout(prior.flushTimer);
  }
  setPersistenceState({
    config: { stateDir, fileName },
    loadedMtimeMs: null,
    loadedOnce: false,
    flushTimer: null
  });

  try {
    process.env.ROUTECODEX_ANTIGRAVITY_SIGNATURE_STATE_DIR = stateDir;
    process.env.ROUTECODEX_ANTIGRAVITY_SIGNATURE_FILE = fileName;
  } catch {
    // best-effort only
  }

  // Ensure we hydrate immediately so a short-lived process (or a server restart)
  // never flushes an empty in-memory cache over an existing persisted file.
  try {
    hydrateSignaturesFromDiskIfNeeded(true);
  } catch {
    // best-effort only
  }
}

export function flushAntigravitySessionSignaturePersistenceSync(): void {
  const state = getPersistenceState();
  if (!state) {
    return;
  }
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  flushPersistedSignaturesSync(state);
}

const GLOBAL_SIGNATURE_CACHE_KEY = '__LLMSWITCH_ANTIGRAVITY_SESSION_SIGNATURE_CACHE__';
const GLOBAL_REQUEST_SESSION_CACHE_KEY = '__LLMSWITCH_ANTIGRAVITY_REQUEST_SESSION_ID_CACHE__';
const GLOBAL_PINNED_ALIAS_BY_SESSION_KEY = '__LLMSWITCH_ANTIGRAVITY_PINNED_ALIAS_BY_SESSION__';
const GLOBAL_PINNED_SESSION_BY_ALIAS_KEY = '__LLMSWITCH_ANTIGRAVITY_PINNED_SESSION_BY_ALIAS__';

function getGlobalSignatureCache(): Map<string, SessionSignatureEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[GLOBAL_SIGNATURE_CACHE_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, SessionSignatureEntry>;
  }
  const created = new Map<string, SessionSignatureEntry>();
  g[GLOBAL_SIGNATURE_CACHE_KEY] = created;
  return created;
}

const sessionSignatures = getGlobalSignatureCache();

type RequestSessionEntry = {
  aliasKey: string;
  sessionId: string;
  messageCount: number;
  timestamp: number;
};

function getGlobalRequestSessionCache(): Map<string, RequestSessionEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[GLOBAL_REQUEST_SESSION_CACHE_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, RequestSessionEntry>;
  }
  const created = new Map<string, RequestSessionEntry>();
  g[GLOBAL_REQUEST_SESSION_CACHE_KEY] = created;
  return created;
}

const requestSessionIds = getGlobalRequestSessionCache();

type RewindBlockEntry = { until: number; timestamp: number; messageCount: number };
const GLOBAL_REWIND_BLOCK_CACHE_KEY = '__LLMSWITCH_ANTIGRAVITY_SIGNATURE_REWIND_BLOCK_CACHE__';

function getGlobalRewindBlockCache(): Map<string, RewindBlockEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[GLOBAL_REWIND_BLOCK_CACHE_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, RewindBlockEntry>;
  }
  const created = new Map<string, RewindBlockEntry>();
  g[GLOBAL_REWIND_BLOCK_CACHE_KEY] = created;
  return created;
}

const rewindBlocks = getGlobalRewindBlockCache();

const GLOBAL_LATEST_SIGNATURE_BY_ALIAS_KEY = '__LLMSWITCH_ANTIGRAVITY_LATEST_SIGNATURE_BY_ALIAS__';

// Antigravity-Manager alignment: global thoughtSignature store (v2).
// - Shared across all Antigravity/GeminiCLI accounts for the SAME derived sessionId.
// - Still keyed by sessionId to avoid cross-session leakage.
export const ANTIGRAVITY_GLOBAL_ALIAS_KEY = 'antigravity.global';

function normalizeAliasKey(value: unknown): string {
  if (typeof value !== 'string') {
    return 'antigravity.unknown';
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return 'antigravity.unknown';
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === 'antigravity') {
    return 'antigravity.unknown';
  }
  return lowered;
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function buildSignatureCacheKey(aliasKey: unknown, sessionId: unknown): string {
  const alias = normalizeAliasKey(aliasKey);
  const sid = normalizeSessionId(sessionId);
  if (!sid) {
    return '';
  }
  return `${alias}|${sid}`;
}

function getLatestSignatureMap(): Map<string, LatestSignatureEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[GLOBAL_LATEST_SIGNATURE_BY_ALIAS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, LatestSignatureEntry>;
  }
  const created = new Map<string, LatestSignatureEntry>();
  g[GLOBAL_LATEST_SIGNATURE_BY_ALIAS_KEY] = created;
  return created;
}

const latestSignaturesByAlias = getLatestSignatureMap();

function getPinnedAliasBySessionMap(): Map<string, PinnedAliasEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[GLOBAL_PINNED_ALIAS_BY_SESSION_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, PinnedAliasEntry>;
  }
  const created = new Map<string, PinnedAliasEntry>();
  g[GLOBAL_PINNED_ALIAS_BY_SESSION_KEY] = created;
  return created;
}

function getPinnedSessionByAliasMap(): Map<string, PinnedSessionEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[GLOBAL_PINNED_SESSION_BY_ALIAS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, PinnedSessionEntry>;
  }
  const created = new Map<string, PinnedSessionEntry>();
  g[GLOBAL_PINNED_SESSION_BY_ALIAS_KEY] = created;
  return created;
}

const pinnedAliasBySession = getPinnedAliasBySessionMap();
const pinnedSessionByAlias = getPinnedSessionByAliasMap();

export function getAntigravityThoughtSignatureSentinel(): string {
  return DUMMY_THOUGHT_SIGNATURE_SENTINEL;
}

function shouldAllowAliasLatestFallback(aliasKey: unknown): boolean {
  const normalized = normalizeAliasKey(aliasKey);
  // Never fall back when alias is unknown: avoids cross-alias mixing and enforces isolation.
  return normalized !== 'antigravity.unknown';
}

function getLatestSignatureEntry(aliasKey: unknown): LatestSignatureEntry | null {
  const key = normalizeAliasKey(aliasKey);
  const existing = latestSignaturesByAlias.get(key);
  if (existing && typeof existing === 'object') {
    const signature = typeof existing.signature === 'string' ? existing.signature : '';
    const messageCount = typeof existing.messageCount === 'number' ? existing.messageCount : 1;
    const timestamp = typeof existing.timestamp === 'number' ? existing.timestamp : 0;
    const sessionId = typeof (existing as LatestSignatureEntry).sessionId === 'string'
      ? String((existing as LatestSignatureEntry).sessionId)
      : '';
    if (signature && timestamp > 0) {
      return { signature, messageCount, timestamp, ...(sessionId.trim().length ? { sessionId: sessionId.trim() } : {}) };
    }
  }
  return null;
}

function setLatestSignatureEntry(aliasKey: unknown, entry: LatestSignatureEntry | null): void {
  const key = normalizeAliasKey(aliasKey);
  if (!entry) {
    latestSignaturesByAlias.delete(key);
    return;
  }
  latestSignaturesByAlias.set(key, entry);
}

function nowMs(): number {
  return Date.now();
}

function isTimeExpiryEnabled(): boolean {
  return typeof SIGNATURE_TTL_MS === 'number' && Number.isFinite(SIGNATURE_TTL_MS) && SIGNATURE_TTL_MS > 0;
}

export function getAntigravityLatestSignatureSessionIdForAlias(
  aliasKeyInput: string,
  options?: { hydrate?: boolean }
): string | undefined {
  const allowHydrate = options?.hydrate !== false;
  const aliasKey = normalizeAliasKey(aliasKeyInput);
  if (!shouldAllowAliasLatestFallback(aliasKey)) {
    return undefined;
  }
  if (allowHydrate) {
    hydrateSignaturesFromDiskIfNeeded(true);
  }
  const latest = getLatestSignatureEntry(aliasKey);
  if (!latest) {
    return undefined;
  }
  if (isTimeExpiryEnabled()) {
    const ts = nowMs();
    if (ts - latest.timestamp > SIGNATURE_TTL_MS) {
      return undefined;
    }
  }
  const sessionId = typeof latest.sessionId === 'string' ? latest.sessionId.trim() : '';
  return sessionId || undefined;
}

function extractSessionIdFromCacheKey(key: string): string {
  if (typeof key !== 'string' || !key) return '';
  const idx = key.indexOf('|');
  if (idx < 0) return '';
  return key.slice(idx + 1).trim();
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as UnknownRecord;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

function jsonStringifyFallback(value: unknown): string {
  // Antigravity-Manager uses `serde_json::Value::to_string()` for the fallback seed.
  // In JS, JSON.stringify preserves insertion order and is the closest equivalent.
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return stableStringify(value);
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isExpired(entry: SessionSignatureEntry, ts: number): boolean {
  if (!isTimeExpiryEnabled()) {
    return false;
  }
  return ts - entry.timestamp > SIGNATURE_TTL_MS;
}

function isPinnedExpired(entry: { timestamp: number }, ts: number): boolean {
  if (!isTimeExpiryEnabled()) {
    return false;
  }
  return ts - entry.timestamp > SIGNATURE_TTL_MS;
}

function isRequestSessionExpired(entry: RequestSessionEntry, ts: number): boolean {
  if (!isTimeExpiryEnabled()) {
    return false;
  }
  return ts - entry.timestamp > SIGNATURE_TTL_MS;
}

function touchSessionSignature(aliasKey: string, cacheKey: string, entry: SessionSignatureEntry, ts: number): void {
  if (ts - entry.timestamp < SIGNATURE_TOUCH_INTERVAL_MS) {
    return;
  }
  sessionSignatures.set(cacheKey, { signature: entry.signature, messageCount: entry.messageCount, timestamp: ts });
  const latest = getLatestSignatureEntry(aliasKey);
  if (!latest || ts >= latest.timestamp) {
    const sessionId = extractSessionIdFromCacheKey(cacheKey);
    setLatestSignatureEntry(aliasKey, {
      signature: entry.signature,
      messageCount: entry.messageCount,
      timestamp: ts,
      ...(sessionId ? { sessionId } : {})
    });
  }
  schedulePersistenceFlush();
}

function pruneExpired(): void {
  if (!isTimeExpiryEnabled()) {
    return;
  }
  const ts = nowMs();
  for (const [key, entry] of sessionSignatures.entries()) {
    if (isExpired(entry, ts)) {
      sessionSignatures.delete(key);
    }
  }
  for (const [sessionId, entry] of pinnedAliasBySession.entries()) {
    if (isPinnedExpired(entry, ts)) {
      pinnedAliasBySession.delete(sessionId);
      const aliasKey = typeof entry.aliasKey === 'string' ? entry.aliasKey : '';
      if (aliasKey) {
        const backref = pinnedSessionByAlias.get(aliasKey);
        if (backref?.sessionId === sessionId) {
          pinnedSessionByAlias.delete(aliasKey);
        }
      }
    }
  }
  for (const [aliasKey, entry] of pinnedSessionByAlias.entries()) {
    if (isPinnedExpired(entry, ts)) {
      pinnedSessionByAlias.delete(aliasKey);
      const sid = typeof entry.sessionId === 'string' ? entry.sessionId : '';
      if (sid) {
        const backref = pinnedAliasBySession.get(sid);
        if (backref?.aliasKey === aliasKey) {
          pinnedAliasBySession.delete(sid);
        }
      }
    }
  }
}

function ensureCacheLimit(): void {
  if (sessionSignatures.size <= SESSION_CACHE_LIMIT) {
    return;
  }
  pruneExpired();
  if (sessionSignatures.size <= SESSION_CACHE_LIMIT) {
    return;
  }
  // Best-effort: remove the oldest entries until within limit.
  const entries = Array.from(sessionSignatures.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
  const overflow = sessionSignatures.size - SESSION_CACHE_LIMIT;
  for (let i = 0; i < overflow; i++) {
    const key = entries[i]?.[0];
    if (key) {
      sessionSignatures.delete(key);
    }
  }
}

function resolvePersistFilePath(config: PersistenceConfig): string {
  return path.join(config.stateDir, config.fileName);
}

function isValidPersistedEntry(value: unknown): value is SessionSignatureEntry {
  if (!isRecord(value)) return false;
  const sig = typeof value.signature === 'string' ? value.signature.trim() : '';
  if (!sig || sig.length < MIN_SIGNATURE_LENGTH) return false;
  if (sig === DUMMY_THOUGHT_SIGNATURE_SENTINEL) return false;
  const messageCount =
    typeof value.messageCount === 'number' && Number.isFinite(value.messageCount) && value.messageCount > 0
      ? Math.floor(value.messageCount)
      : 1;
  const timestamp =
    typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) && value.timestamp > 0
      ? Math.floor(value.timestamp)
      : 0;
  if (!timestamp) return false;
  (value as SessionSignatureEntry).signature = sig;
  (value as SessionSignatureEntry).messageCount = messageCount;
  (value as SessionSignatureEntry).timestamp = timestamp;
  return true;
}

function hydrateSignaturesFromDiskIfNeeded(force = false): void {
  const state = getPersistenceState();
  if (!state) {
    return;
  }
  const filePath = resolvePersistFilePath(state.config);

  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    state.loadedOnce = true;
    state.loadedMtimeMs = null;
    return;
  }

  const mtimeMs = typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.mtime.getTime();
  if (!force && state.loadedOnce && state.loadedMtimeMs === mtimeMs) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    state.loadedOnce = true;
    state.loadedMtimeMs = mtimeMs;
    return;
  }

  const latestRaw = isRecord(parsed) ? (parsed as UnknownRecord).latest : undefined;
  const latestPersisted = isValidPersistedEntry(latestRaw)
    ? ({ ...(latestRaw as SessionSignatureEntry) } as SessionSignatureEntry)
    : null;

  const latestByAliasRaw = isRecord(parsed) ? (parsed as UnknownRecord).latestByAlias : undefined;
  const latestByAlias = isRecord(latestByAliasRaw) ? (latestByAliasRaw as UnknownRecord) : undefined;

  const sessionsRaw = isRecord(parsed) ? (parsed as UnknownRecord).sessions : undefined;
  const sessions = isRecord(sessionsRaw) ? (sessionsRaw as UnknownRecord) : undefined;
  if (!sessions) {
    state.loadedOnce = true;
    state.loadedMtimeMs = mtimeMs;
    return;
  }

  const tsNow = nowMs();
  const pinnedBySessionRaw = isRecord(parsed) ? (parsed as UnknownRecord).pinnedBySession : undefined;
  const pinnedBySession = isRecord(pinnedBySessionRaw) ? (pinnedBySessionRaw as UnknownRecord) : undefined;
  if (pinnedBySession) {
    for (const [sessionIdRaw, entryRaw] of Object.entries(pinnedBySession)) {
      const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
      if (!sessionId) continue;
      if (!isRecord(entryRaw)) continue;
      const aliasKeyRaw = (entryRaw as UnknownRecord).aliasKey;
      const aliasKey = typeof aliasKeyRaw === 'string' ? aliasKeyRaw.trim() : '';
      const timestampRaw = (entryRaw as UnknownRecord).timestamp;
      const timestamp = typeof timestampRaw === 'number' && Number.isFinite(timestampRaw) ? Math.floor(timestampRaw) : 0;
      if (!aliasKey || !timestamp) continue;
      if (isPinnedExpired({ timestamp }, tsNow)) continue;
      const normalizedAlias = normalizeAliasKey(aliasKey);
      const existing = pinnedAliasBySession.get(sessionId);
      if (existing && !isPinnedExpired(existing, tsNow) && existing.timestamp >= timestamp) {
        continue;
      }
      pinnedAliasBySession.set(sessionId, { aliasKey: normalizedAlias, timestamp });
    }
  }
  const pinnedByAliasRaw = isRecord(parsed) ? (parsed as UnknownRecord).pinnedByAlias : undefined;
  const pinnedByAlias = isRecord(pinnedByAliasRaw) ? (pinnedByAliasRaw as UnknownRecord) : undefined;
  if (pinnedByAlias) {
    for (const [aliasKeyRaw, entryRaw] of Object.entries(pinnedByAlias)) {
      const aliasKey = typeof aliasKeyRaw === 'string' ? aliasKeyRaw.trim() : '';
      if (!aliasKey) continue;
      if (!isRecord(entryRaw)) continue;
      const sessionIdRaw = (entryRaw as UnknownRecord).sessionId;
      const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
      const timestampRaw = (entryRaw as UnknownRecord).timestamp;
      const timestamp = typeof timestampRaw === 'number' && Number.isFinite(timestampRaw) ? Math.floor(timestampRaw) : 0;
      if (!sessionId || !timestamp) continue;
      if (isPinnedExpired({ timestamp }, tsNow)) continue;
      const normalizedAlias = normalizeAliasKey(aliasKey);
      const existing = pinnedSessionByAlias.get(normalizedAlias);
      if (existing && !isPinnedExpired(existing, tsNow) && existing.timestamp >= timestamp) {
        continue;
      }
      pinnedSessionByAlias.set(normalizedAlias, { sessionId, timestamp });
    }
  }

  const syncNativeSignature = (cacheKey: string, entry: SessionSignatureEntry): void => {
    const aliasKey = cacheKey.split('|')[0]?.trim() ?? '';
    const sessionId = extractSessionIdFromCacheKey(cacheKey);
    if (!aliasKey || !sessionId) {
      return;
    }
    if (aliasKey === 'antigravity.unknown' || aliasKey === ANTIGRAVITY_GLOBAL_ALIAS_KEY) {
      return;
    }
    try {
      cacheAntigravitySessionSignatureWithNative({
        aliasKey,
        sessionId,
        signature: entry.signature,
        messageCount: entry.messageCount
      });
    } catch {
      // best-effort native sync; JS cache remains source of truth for persistence
    }
  };

  for (const [persistedKey, entry] of Object.entries(sessions)) {
    if (typeof persistedKey !== 'string' || !persistedKey.trim()) continue;
    if (!isValidPersistedEntry(entry)) continue;
    if (isExpired(entry, tsNow)) continue;
    const keyTrimmed = persistedKey.trim();
    const isScopedKey = keyTrimmed.includes('|');
    const normalizedKeys = isScopedKey
      ? [keyTrimmed]
      : [
          // Legacy v1 persistence stored signatures keyed only by sid-*.
          // Treat them as session-global so they can be used for any alias (v2 global store).
          buildSignatureCacheKey(ANTIGRAVITY_GLOBAL_ALIAS_KEY, keyTrimmed),
          buildSignatureCacheKey('antigravity.unknown', keyTrimmed)
        ].filter(Boolean);
    for (const normalizedKey of normalizedKeys) {
      if (!normalizedKey) continue;
      const existing = sessionSignatures.get(normalizedKey);
      if (existing && !isExpired(existing, tsNow) && existing.timestamp >= (entry as SessionSignatureEntry).timestamp) {
        continue;
      }
      sessionSignatures.set(normalizedKey, entry);
      syncNativeSignature(normalizedKey, entry);
    }
  }

  latestSignaturesByAlias.clear();
  if (latestByAlias) {
    for (const [aliasKeyRaw, entryRaw] of Object.entries(latestByAlias)) {
      if (typeof aliasKeyRaw !== 'string' || !aliasKeyRaw.trim()) continue;
      if (!isValidPersistedEntry(entryRaw)) continue;
      if (isExpired(entryRaw, tsNow)) continue;
      const sessionIdCandidate =
        isRecord(entryRaw) && typeof (entryRaw as UnknownRecord).sessionId === 'string'
          ? String((entryRaw as UnknownRecord).sessionId).trim()
          : '';
      setLatestSignatureEntry(aliasKeyRaw, {
        signature: (entryRaw as SessionSignatureEntry).signature,
        messageCount: (entryRaw as SessionSignatureEntry).messageCount,
        timestamp: (entryRaw as SessionSignatureEntry).timestamp,
        ...(sessionIdCandidate ? { sessionId: sessionIdCandidate } : {})
      });
    }
  }
  // Legacy v1 persistence ("latest" without alias) is kept only under "unknown" to avoid cross-alias mixing.
  if (latestSignaturesByAlias.size === 0 && latestPersisted && !isExpired(latestPersisted, tsNow)) {
    setLatestSignatureEntry('antigravity.unknown', {
      signature: latestPersisted.signature,
      messageCount: latestPersisted.messageCount,
      timestamp: latestPersisted.timestamp
    });
  }
  // Recompute per-alias latest values from session cache as a final best-effort pass.
  for (const [key, entry] of sessionSignatures.entries()) {
    if (isExpired(entry, tsNow)) continue;
    const alias = key.split('|')[0] ?? 'unknown';
    const existing = getLatestSignatureEntry(alias);
    if (!existing || entry.timestamp > existing.timestamp) {
      const sessionId = extractSessionIdFromCacheKey(key);
      setLatestSignatureEntry(alias, {
        signature: entry.signature,
        messageCount: entry.messageCount,
        timestamp: entry.timestamp,
        ...(sessionId ? { sessionId } : {})
      });
    }
  }
  ensureCacheLimit();

  state.loadedOnce = true;
  state.loadedMtimeMs = mtimeMs;
}

function flushPersistedSignaturesSync(state: PersistenceState): void {
  const filePath = resolvePersistFilePath(state.config);
  // Avoid wiping existing persisted signatures when this process hasn't cached anything yet.
  // Always re-hydrate before writing.
  hydrateSignaturesFromDiskIfNeeded(true);
  const tsNow = nowMs();
  pruneExpired();
  ensureCacheLimit();

  const sessions: Record<string, SessionSignatureEntry> = {};
  for (const [sid, entry] of sessionSignatures.entries()) {
    if (isExpired(entry, tsNow)) continue;
    if (!entry.signature || entry.signature.trim().length < MIN_SIGNATURE_LENGTH) continue;
    if (entry.signature.trim() === DUMMY_THOUGHT_SIGNATURE_SENTINEL) continue;
    sessions[sid] = entry;
  }

  const latestByAliasPersist: Record<string, LatestSignatureEntry> = {};
  for (const [aliasKey, entry] of latestSignaturesByAlias.entries()) {
    if (!entry.signature || entry.signature.trim().length < MIN_SIGNATURE_LENGTH) continue;
    if (entry.signature.trim() === DUMMY_THOUGHT_SIGNATURE_SENTINEL) continue;
    latestByAliasPersist[aliasKey] = entry;
  }

  const pinnedBySessionPersist: Record<string, PinnedAliasEntry> = {};
  for (const [sessionId, entry] of pinnedAliasBySession.entries()) {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) continue;
    const aliasKey = typeof entry?.aliasKey === 'string' ? entry.aliasKey.trim() : '';
    const timestamp = typeof entry?.timestamp === 'number' && Number.isFinite(entry.timestamp) ? Math.floor(entry.timestamp) : 0;
    if (!aliasKey || !timestamp) continue;
    if (isPinnedExpired({ timestamp }, tsNow)) continue;
    pinnedBySessionPersist[sid] = { aliasKey, timestamp };
  }

  const pinnedByAliasPersist: Record<string, PinnedSessionEntry> = {};
  for (const [aliasKey, entry] of pinnedSessionByAlias.entries()) {
    const a = typeof aliasKey === 'string' ? aliasKey.trim() : '';
    if (!a) continue;
    const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId.trim() : '';
    const timestamp = typeof entry?.timestamp === 'number' && Number.isFinite(entry.timestamp) ? Math.floor(entry.timestamp) : 0;
    if (!sessionId || !timestamp) continue;
    if (isPinnedExpired({ timestamp }, tsNow)) continue;
    pinnedByAliasPersist[a] = { sessionId, timestamp };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${tsNow}`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify(
        {
          version: 3,
          updatedAt: tsNow,
          sessions,
          ...(Object.keys(latestByAliasPersist).length ? { latestByAlias: latestByAliasPersist } : {}),
          ...(Object.keys(pinnedBySessionPersist).length ? { pinnedBySession: pinnedBySessionPersist } : {}),
          ...(Object.keys(pinnedByAliasPersist).length ? { pinnedByAlias: pinnedByAliasPersist } : {})
        },
        null,
        2
      ),
      'utf8'
    );
    fs.renameSync(tmpPath, filePath);
    try {
      const stat = fs.statSync(filePath);
      const mtimeMs =
        typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.mtime.getTime();
      state.loadedOnce = true;
      state.loadedMtimeMs = mtimeMs;
    } catch {
      // ignore
    }
  } catch {
    // best-effort persistence: must not affect runtime
  }
}

function schedulePersistenceFlush(): void {
  const state = getPersistenceState();
  if (!state) {
    return;
  }
  if (state.flushTimer) {
    return;
  }
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    flushPersistedSignaturesSync(state);
  }, 250);
  state.flushTimer.unref?.();
}

export function cacheAntigravityRequestSessionId(requestId: string, aliasKey: string, sessionId: string): void;
export function cacheAntigravityRequestSessionId(requestId: string, sessionId: string): void;
export function cacheAntigravityRequestSessionId(requestId: string, a: string, b?: string): void {
  if (typeof b === 'string') {
    cacheAntigravityRequestSessionMeta(requestId, { aliasKey: a, sessionId: b });
    return;
  }
  cacheAntigravityRequestSessionMeta(requestId, { sessionId: a });
}

export function cacheAntigravityRequestSessionMeta(
  requestId: string,
  meta: { aliasKey?: string; sessionId: string; messageCount?: number }
): void {
  const rid = typeof requestId === 'string' ? requestId.trim() : '';
  const sid = typeof meta?.sessionId === 'string' ? meta.sessionId.trim() : '';
  if (!rid || !sid) {
    return;
  }
  const aliasKey = normalizeAliasKey(meta?.aliasKey);
  const messageCount =
    typeof meta?.messageCount === 'number' && Number.isFinite(meta.messageCount) && meta.messageCount > 0
      ? Math.floor(meta.messageCount)
      : 1;
  const ts = nowMs();
  requestSessionIds.set(rid, { aliasKey, sessionId: sid, messageCount, timestamp: ts });
  if (requestSessionIds.size <= SESSION_CACHE_LIMIT) {
    return;
  }
  // Best-effort cleanup to avoid unbounded growth.
  const entries = Array.from(requestSessionIds.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
  const overflow = requestSessionIds.size - SESSION_CACHE_LIMIT;
  for (let i = 0; i < overflow; i++) {
    const key = entries[i]?.[0];
    if (key) {
      requestSessionIds.delete(key);
    }
  }
}

export function getAntigravityRequestSessionId(requestId: string): string | undefined {
  const meta = getAntigravityRequestSessionMeta(requestId);
  return meta?.sessionId;
}

export function getAntigravityRequestSessionMeta(
  requestId: string
): { aliasKey: string; sessionId: string; messageCount: number } | undefined {
  const rid = typeof requestId === 'string' ? requestId.trim() : '';
  if (!rid) {
    return undefined;
  }
  const entry = requestSessionIds.get(rid);
  if (!entry) {
    try {
      const nativeMeta = getAntigravityRequestSessionMetaWithNative(rid);
      const sid = typeof nativeMeta.sessionId === 'string' ? nativeMeta.sessionId.trim() : '';
      if (!sid) {
        return undefined;
      }
      const alias = normalizeAliasKey(nativeMeta.aliasKey);
      const messageCount =
        typeof nativeMeta.messageCount === 'number' && Number.isFinite(nativeMeta.messageCount) && nativeMeta.messageCount > 0
          ? Math.floor(nativeMeta.messageCount)
          : 1;
      const ts = nowMs();
      requestSessionIds.set(rid, { aliasKey: alias, sessionId: sid, messageCount, timestamp: ts });
      return { aliasKey: alias, sessionId: sid, messageCount };
    } catch {
      return undefined;
    }
  }
  const ts = nowMs();
  if (isRequestSessionExpired(entry, ts)) {
    requestSessionIds.delete(rid);
    return undefined;
  }
  return { aliasKey: entry.aliasKey, sessionId: entry.sessionId, messageCount: entry.messageCount };
}

function findGeminiContentsNode(payload: unknown): UnknownRecord | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (Array.isArray((payload as UnknownRecord).contents)) {
    return payload as UnknownRecord;
  }
  const nested = (payload as UnknownRecord).request;
  if (isRecord(nested) && Array.isArray((nested as UnknownRecord).contents)) {
    return nested as UnknownRecord;
  }
  const data = (payload as UnknownRecord).data;
  if (isRecord(data)) {
    return findGeminiContentsNode(data);
  }
  return payload as UnknownRecord;
}

/**
 * Antigravity-Manager alignment: derive a stable session fingerprint for Gemini native requests.
 * - sha256(first user text parts joined), if non-empty and no "<system-reminder>"
 * - else sha256(JSON body)
 * - sid = "sid-" + first 16 hex chars
 */
export function extractAntigravityGeminiSessionId(payload: unknown): string {
  const node = findGeminiContentsNode(payload) ?? {};
  let seed: string | undefined;
  const contentsRaw = node.contents;
  const contents = Array.isArray(contentsRaw) ? (contentsRaw as UnknownRecord[]) : [];
  for (const content of contents) {
    if (!isRecord(content)) continue;
    if (typeof content.role !== 'string' || content.role !== 'user') continue;
    const partsRaw = content.parts;
    const parts = Array.isArray(partsRaw) ? (partsRaw as UnknownRecord[]) : [];
    const texts: string[] = [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const text = typeof part.text === 'string' ? part.text : '';
      if (text) {
        texts.push(text);
      }
    }
    const combined = texts.join(' ').trim();
    // RouteCodex signature persistence alignment:
    // - Prefer the first user message text as the stable session anchor, even when short.
    // - Skip system-reminder carrier messages (common in tool followups).
    if (combined.length > 0 && !combined.includes('<system-reminder>')) {
      seed = combined;
      break;
    }
  }
  if (!seed) {
    seed = jsonStringifyFallback(node);
  }
  const hash = sha256Hex(seed);
  return `sid-${hash.slice(0, 16)}`;
}

export function cacheAntigravitySessionSignature(aliasKey: string, sessionId: string, signature: string, messageCount?: number): void;
export function cacheAntigravitySessionSignature(sessionId: string, signature: string, messageCount?: number): void;
export function cacheAntigravitySessionSignature(a: string, b: string, c?: string | number, d = 1): void {
  const isNewSignature = typeof c === 'string';
  const aliasKey = isNewSignature ? a : 'antigravity.unknown';
  const sessionId = isNewSignature ? b : a;
  const signature = isNewSignature ? (c as string) : b;
  const messageCount = typeof c === 'number' ? c : typeof d === 'number' ? d : 1;

  const key = buildSignatureCacheKey(aliasKey, sessionId);
  if (!key) {
    return;
  }
  if (typeof signature !== 'string') {
    return;
  }
  const trimmedSignature = signature.trim();
  if (trimmedSignature.length < MIN_SIGNATURE_LENGTH || trimmedSignature === DUMMY_THOUGHT_SIGNATURE_SENTINEL) {
    return;
  }

  const ts = nowMs();
  const existing = sessionSignatures.get(key);

  let shouldStore = false;
  if (!existing) {
    shouldStore = true;
  } else if (isExpired(existing, ts)) {
    shouldStore = true;
  } else if (messageCount < existing.messageCount) {
    // Rewind detected: allow overwrite.
    shouldStore = true;
  } else if (messageCount === existing.messageCount) {
    shouldStore = signature.length > existing.signature.length;
  } else {
    shouldStore = true;
  }

  if (!shouldStore) {
    return;
  }

  sessionSignatures.set(key, { signature: trimmedSignature, messageCount, timestamp: ts });
  rewindBlocks.delete(key);
  const latest = getLatestSignatureEntry(aliasKey);
  if (!latest || ts >= latest.timestamp) {
    setLatestSignatureEntry(aliasKey, { signature: trimmedSignature, messageCount, timestamp: ts, sessionId });
  }
  maybePinAntigravitySessionToAlias(aliasKey, sessionId, ts);
  ensureCacheLimit();
  schedulePersistenceFlush();
  try {
    cacheAntigravitySessionSignatureWithNative({
      aliasKey,
      sessionId,
      signature: trimmedSignature,
      messageCount
    });
  } catch {
    // best-effort native sync; TS cache remains source for persistence semantics
  }
}

function maybePinAntigravitySessionToAlias(aliasKeyInput: string, sessionIdInput: string, ts: number): void {
  const aliasKey = normalizeAliasKey(aliasKeyInput);
  const sessionId = normalizeSessionId(sessionIdInput);
  if (!sessionId) {
    return;
  }
  if (aliasKey === 'antigravity.unknown' || aliasKey === ANTIGRAVITY_GLOBAL_ALIAS_KEY) {
    return;
  }
  const existing = pinnedAliasBySession.get(sessionId);
  if (existing && !isPinnedExpired(existing, ts)) {
    if (existing.aliasKey === aliasKey && ts - existing.timestamp >= SIGNATURE_TOUCH_INTERVAL_MS) {
      pinnedAliasBySession.set(sessionId, { aliasKey, timestamp: ts });
      pinnedSessionByAlias.set(aliasKey, { sessionId, timestamp: ts });
      schedulePersistenceFlush();
    }
    return;
  }
  const existingForAlias = pinnedSessionByAlias.get(aliasKey);
  if (existingForAlias && !isPinnedExpired(existingForAlias, ts) && existingForAlias.sessionId !== sessionId) {
    return;
  }
  pinnedAliasBySession.set(sessionId, { aliasKey, timestamp: ts });
  pinnedSessionByAlias.set(aliasKey, { sessionId, timestamp: ts });
  schedulePersistenceFlush();
}

export function lookupAntigravityPinnedAliasForSessionId(
  sessionIdInput: string,
  options?: { hydrate?: boolean }
): string | undefined {
  const sessionId = normalizeSessionId(sessionIdInput);
  if (!sessionId) {
    return undefined;
  }
  const allowHydrate = options?.hydrate !== false;
  if (allowHydrate) {
    hydrateSignaturesFromDiskIfNeeded(true);
  }
  const entry = pinnedAliasBySession.get(sessionId);
  if (!entry) {
    return undefined;
  }
  const ts = nowMs();
  if (isPinnedExpired(entry, ts)) {
    pinnedAliasBySession.delete(sessionId);
    return undefined;
  }
  if (ts - entry.timestamp >= SIGNATURE_TOUCH_INTERVAL_MS) {
    pinnedAliasBySession.set(sessionId, { aliasKey: entry.aliasKey, timestamp: ts });
    pinnedSessionByAlias.set(entry.aliasKey, { sessionId, timestamp: ts });
    schedulePersistenceFlush();
  }
  return entry.aliasKey;
}

export function unpinAntigravitySessionAliasForSessionId(sessionIdInput: string): void {
  const sessionId = normalizeSessionId(sessionIdInput);
  if (!sessionId) {
    return;
  }
  hydrateSignaturesFromDiskIfNeeded(true);
  const existing = pinnedAliasBySession.get(sessionId);
  if (!existing) {
    return;
  }
  pinnedAliasBySession.delete(sessionId);
  const aliasKey = typeof existing.aliasKey === 'string' ? existing.aliasKey : '';
  if (aliasKey) {
    const backref = pinnedSessionByAlias.get(aliasKey);
    if (backref?.sessionId === sessionId) {
      pinnedSessionByAlias.delete(aliasKey);
    }
  }
  schedulePersistenceFlush();
}

export function clearAntigravitySessionAliasPins(options?: { hydrate?: boolean }): {
  clearedBySession: number;
  clearedByAlias: number;
} {
  const allowHydrate = options?.hydrate !== false;
  if (allowHydrate) {
    hydrateSignaturesFromDiskIfNeeded(true);
  }
  const clearedBySession = pinnedAliasBySession.size;
  const clearedByAlias = pinnedSessionByAlias.size;
  if (clearedBySession === 0 && clearedByAlias === 0) {
    return { clearedBySession: 0, clearedByAlias: 0 };
  }
  pinnedAliasBySession.clear();
  pinnedSessionByAlias.clear();
  schedulePersistenceFlush();
  return { clearedBySession, clearedByAlias };
}

export function getAntigravitySessionSignature(aliasKey: string, sessionId: string): string | undefined;
export function getAntigravitySessionSignature(sessionId: string): string | undefined;
export function getAntigravitySessionSignature(a: string, b?: string): string | undefined {
  return getAntigravitySessionSignatureEntry(a, b as string | undefined)?.signature;
}

export type AntigravityThoughtSignatureLookupSource =
  | 'session_cache'
  | 'miss'
  | 'blocked_unknown_alias'
  | 'blocked_rewind'
  | 'expired';

export type AntigravityThoughtSignatureLookupResult = {
  aliasKey: string;
  sessionId: string;
  cacheKey: string;
  source: AntigravityThoughtSignatureLookupSource;
  signature?: string;
  messageCount?: number;
  sourceSessionId?: string;
  sourceTimestamp?: number;
};

export function lookupAntigravitySessionSignatureEntry(
  aliasKeyInput: string,
  sessionIdInput: string,
  options?: { hydrate?: boolean }
): AntigravityThoughtSignatureLookupResult {
  const allowHydrate = options?.hydrate !== false;
  const aliasKey = normalizeAliasKey(aliasKeyInput);
  const sessionId = normalizeSessionId(sessionIdInput);
  const cacheKey = buildSignatureCacheKey(aliasKey, sessionId);
  if (!cacheKey) {
    return { aliasKey, sessionId, cacheKey, source: 'miss' };
  }

  let entry = sessionSignatures.get(cacheKey);
  if (!entry && allowHydrate) {
    hydrateSignaturesFromDiskIfNeeded(true);
    entry = sessionSignatures.get(cacheKey);
  }
  if (entry) {
    const ts = nowMs();
    if (isExpired(entry, ts)) {
      sessionSignatures.delete(cacheKey);
      return { aliasKey, sessionId, cacheKey, source: 'expired' };
    }
    touchSessionSignature(aliasKey, cacheKey, entry, ts);
    return {
      aliasKey,
      sessionId,
      cacheKey,
      source: 'session_cache',
      signature: entry.signature,
      messageCount: entry.messageCount,
      sourceSessionId: sessionId,
      sourceTimestamp: entry.timestamp
    };
  }

  if (!shouldAllowAliasLatestFallback(aliasKey)) {
    return { aliasKey, sessionId, cacheKey, source: 'blocked_unknown_alias' };
  }

  const ts = nowMs();
  const rewind = rewindBlocks.get(cacheKey);
  if (rewind && ts < rewind.until) {
    return { aliasKey, sessionId, cacheKey, source: 'blocked_rewind' };
  }

  // Antigravity-Manager alignment: do NOT reuse signatures across sessions.
  // If we miss the session cache, the caller must omit thoughtSignature and wait for upstream to provide a real one.
  // (Persistence is still used to restore the same session across restarts, not to "heal" unrelated sessions.)
  if (allowHydrate) {
    hydrateSignaturesFromDiskIfNeeded(true);
    const hydrated = sessionSignatures.get(cacheKey);
    if (hydrated && !isExpired(hydrated, ts)) {
      touchSessionSignature(aliasKey, cacheKey, hydrated, ts);
      return {
        aliasKey,
        sessionId,
        cacheKey,
        source: 'session_cache',
        signature: hydrated.signature,
        messageCount: hydrated.messageCount,
        sourceSessionId: sessionId,
        sourceTimestamp: hydrated.timestamp
      };
    }
  }

  return { aliasKey, sessionId, cacheKey, source: 'miss' };
}

export function getAntigravitySessionSignatureEntry(aliasKey: string, sessionId: string): { signature: string; messageCount: number } | undefined;
export function getAntigravitySessionSignatureEntry(
  aliasKey: string,
  sessionId: string,
  options?: { hydrate?: boolean }
): { signature: string; messageCount: number } | undefined;
export function getAntigravitySessionSignatureEntry(sessionId: string, options?: { hydrate?: boolean }): { signature: string; messageCount: number } | undefined;
export function getAntigravitySessionSignatureEntry(
  a: string,
  b?: string | { hydrate?: boolean },
  c?: { hydrate?: boolean }
): { signature: string; messageCount: number } | undefined {
  const hasAlias = typeof b === 'string';
  const options = (hasAlias ? c : b) as { hydrate?: boolean } | undefined;
  const aliasKey = normalizeAliasKey(hasAlias ? a : 'antigravity.unknown');
  const sessionId = hasAlias ? (b as string) : a;
  const lookup = lookupAntigravitySessionSignatureEntry(aliasKey, sessionId, options);
  if (lookup.signature && typeof lookup.messageCount === 'number') {
    return { signature: lookup.signature, messageCount: lookup.messageCount };
  }
  return undefined;
}

export function clearAntigravitySessionSignature(aliasKey: string, sessionId: string): void;
export function clearAntigravitySessionSignature(sessionId: string): void;
export function clearAntigravitySessionSignature(a: string, b?: string): void {
  const hasAlias = typeof b === 'string';
  const aliasKey = hasAlias ? a : 'antigravity.unknown';
  const sessionId = hasAlias ? (b as string) : a;
  const key = buildSignatureCacheKey(aliasKey, sessionId);
  if (!key) {
    return;
  }
  sessionSignatures.delete(key);
  // Keep latest-by-alias coherent so leasing doesn't keep pointing at a cleared signature.
  if (hasAlias) {
    const latest = getLatestSignatureEntry(aliasKey);
    if (latest?.sessionId && latest.sessionId.trim() === normalizeSessionId(sessionId)) {
      setLatestSignatureEntry(aliasKey, null);
    }
  }
  schedulePersistenceFlush();
}

export function markAntigravitySessionSignatureRewind(aliasKey: string, sessionId: string, messageCount = 1): void {
  const key = buildSignatureCacheKey(aliasKey, sessionId);
  if (!key) {
    return;
  }
  const ts = nowMs();
  const mc = typeof messageCount === 'number' && Number.isFinite(messageCount) && messageCount > 0 ? Math.floor(messageCount) : 1;
  rewindBlocks.set(key, { timestamp: ts, until: ts + REWIND_BLOCK_MS, messageCount: mc });
  // Best-effort bound on memory usage.
  if (rewindBlocks.size > SESSION_CACHE_LIMIT) {
    const entries = Array.from(rewindBlocks.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    const overflow = rewindBlocks.size - SESSION_CACHE_LIMIT;
    for (let i = 0; i < overflow; i++) {
      const k = entries[i]?.[0];
      if (k) rewindBlocks.delete(k);
    }
  }
}

/**
 * Clear thoughtSignature caches + pins for a specific (aliasKey, sessionId).
 *
 * Used for "Invalid signature / Corrupted thought signature / thinking.signature" style upstream errors,
 * where keeping a persisted signature would cause repeated 400s after restart.
 */
export function invalidateAntigravitySessionSignature(aliasKeyInput: string, sessionIdInput: string): void {
  const aliasKey = normalizeAliasKey(aliasKeyInput);
  const sessionId = normalizeSessionId(sessionIdInput);
  if (!sessionId) {
    return;
  }

  hydrateSignaturesFromDiskIfNeeded(true);

  const keys = [
    buildSignatureCacheKey(aliasKey, sessionId),
    buildSignatureCacheKey(ANTIGRAVITY_GLOBAL_ALIAS_KEY, sessionId)
  ].filter((k): k is string => typeof k === 'string' && k.trim().length > 0);

  keys.forEach((k) => sessionSignatures.delete(k));

  const latest = getLatestSignatureEntry(aliasKey);
  if (latest?.sessionId && latest.sessionId.trim() === sessionId) {
    setLatestSignatureEntry(aliasKey, null);
  }
  const globalLatest = getLatestSignatureEntry(ANTIGRAVITY_GLOBAL_ALIAS_KEY);
  if (globalLatest?.sessionId && globalLatest.sessionId.trim() === sessionId) {
    setLatestSignatureEntry(ANTIGRAVITY_GLOBAL_ALIAS_KEY, null);
  }

  // Release any pins so routing can rotate away from a broken tool loop.
  const pinnedAlias = pinnedAliasBySession.get(sessionId);
  if (pinnedAlias) {
    pinnedAliasBySession.delete(sessionId);
    if (typeof pinnedAlias.aliasKey === 'string' && pinnedAlias.aliasKey.trim()) {
      const backref = pinnedSessionByAlias.get(pinnedAlias.aliasKey);
      if (backref?.sessionId === sessionId) {
        pinnedSessionByAlias.delete(pinnedAlias.aliasKey);
      }
    }
  }
  const pinnedSession = pinnedSessionByAlias.get(aliasKey);
  if (pinnedSession?.sessionId === sessionId) {
    pinnedSessionByAlias.delete(aliasKey);
  }

  schedulePersistenceFlush();
}

export function resetAntigravitySessionSignatureCachesForTests(): void {
  sessionSignatures.clear();
  requestSessionIds.clear();
  latestSignaturesByAlias.clear();
  pinnedAliasBySession.clear();
  pinnedSessionByAlias.clear();
  rewindBlocks.clear();
  const persistence = getPersistenceState();
  if (persistence) {
    persistence.loadedOnce = false;
    persistence.loadedMtimeMs = null;
  }
  try {
    resetAntigravitySignatureCachesWithNative();
  } catch {
    // best-effort
  }
}

export function shouldTreatAsMissingThoughtSignature(value: unknown): boolean {
  if (typeof value !== 'string') {
    return true;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === DUMMY_THOUGHT_SIGNATURE_SENTINEL;
}
