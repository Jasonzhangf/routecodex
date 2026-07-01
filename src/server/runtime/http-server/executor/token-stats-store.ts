/**
 * Token Statistics Store
 *
 * Tracks alltime, daily, and per-provider token consumption.
 * Persists to ~/.rcc/token-stats.json (throttled, survives restarts).
 *
 * Important: multiple RouteCodex server processes may run at the same time
 * (for example 5520 + 5555). The persisted file therefore stores per-process
 * session snapshots and every write merges external sessions from disk before
 * committing, so processes do not overwrite each other.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Types ──────────────────────────────────────────────────────────

export interface TokenCounters {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
}

export interface TokenProviderEntry extends TokenCounters {
  providerKey: string;
  model: string;
}

export interface TokenStatsSnapshot {
  alltime: TokenCounters;
  daily: TokenCounters;
  dailyDate: string;
  providers: TokenProviderEntry[];
}

interface PersistedTokenSessionEntry {
  sessionId: string;
  updatedAt: number;
  alltime: TokenCounters;
  daily: Record<string, TokenCounters>;
  providers: Record<string, TokenProviderEntry>;
}

interface PersistedTokenStats {
  version: number;
  sessions?: Record<string, PersistedTokenSessionEntry>;
}

// ── State ──────────────────────────────────────────────────────────

let tokenAlltime: TokenCounters = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0 };
let tokenDaily = new Map<string, TokenCounters>();
let tokenByProvider = new Map<string, TokenProviderEntry>();
let persistedSessions = new Map<string, PersistedTokenSessionEntry>();
let initialized = false;
let dirty = false;
let lastSaveAtMs = 0;
let lastRefreshAtMs = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushInFlight: Promise<void> | null = null;
let pendingFlushAfterCurrent = false;
let exitHookBound = false;
let beforeExitHook: (() => void) | undefined;
let exitHook: (() => void) | undefined;
const SAVE_THROTTLE_MS = 10_000;
const REFRESH_THROTTLE_MS = 1_000;
const currentSessionId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ── Helpers ────────────────────────────────────────────────────────

function getFilePath(): string {
  return path.join(os.homedir(), '.rcc', 'token-stats.json');
}

export function getTodayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function providerMapKey(providerKey: string, model: string): string {
  return `${providerKey}|${model}`;
}

function emptyCounters(): TokenCounters {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0 };
}

function cloneCounters(value: TokenCounters): TokenCounters {
  return {
    promptTokens: Number(value.promptTokens) || 0,
    completionTokens: Number(value.completionTokens) || 0,
    totalTokens: Number(value.totalTokens) || 0,
    cacheReadTokens: Number(value.cacheReadTokens) || 0
  };
}

function cloneDailyMap(source: Map<string, TokenCounters>): Record<string, TokenCounters> {
  const out: Record<string, TokenCounters> = {};
  for (const [key, value] of source.entries()) {
    out[key] = cloneCounters(value);
  }
  return out;
}

function cloneProviderMap(source: Map<string, TokenProviderEntry>): Record<string, TokenProviderEntry> {
  const out: Record<string, TokenProviderEntry> = {};
  for (const [key, value] of source.entries()) {
    out[key] = { ...value, ...cloneCounters(value) };
  }
  return out;
}

function readCounters(value: unknown): TokenCounters {
  if (!value || typeof value !== 'object') {
    return emptyCounters();
  }
  const row = value as Partial<TokenCounters>;
  return {
    promptTokens: Number(row.promptTokens) || 0,
    completionTokens: Number(row.completionTokens) || 0,
    totalTokens: Number(row.totalTokens) || 0,
    cacheReadTokens: Number(row.cacheReadTokens) || 0
  };
}

function readProviderEntry(value: unknown): TokenProviderEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Partial<TokenProviderEntry>;
  return {
    providerKey: String(row.providerKey ?? '') || '',
    model: String(row.model ?? '') || '',
    ...readCounters(row)
  };
}

function accumulateCounters(target: TokenCounters, delta: TokenCounters): void {
  target.promptTokens += delta.promptTokens || 0;
  target.completionTokens += delta.completionTokens || 0;
  target.totalTokens += delta.totalTokens || 0;
  target.cacheReadTokens += delta.cacheReadTokens || 0;
}

function pruneOldDailyEntries(): void {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [key] of tokenDaily) {
    const parts = key.split('-');
    if (parts.length !== 3) {
      continue;
    }
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (d.getTime() < cutoff) {
      tokenDaily.delete(key);
    }
  }
}

function warnSaveFailure(error: unknown, phase: 'load' | 'save'): void {
  console.warn(
    `[token-stats] Failed to ${phase}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function parsePersistedTokenStats(raw: string): Map<string, PersistedTokenSessionEntry> {
  const out = new Map<string, PersistedTokenSessionEntry>();
  const data: PersistedTokenStats = JSON.parse(raw);
  if (!data || typeof data !== 'object') {
    return out;
  }

  if (data.version !== 2 || !data.sessions || typeof data.sessions !== 'object') {
    return out;
  }
  for (const [sessionId, value] of Object.entries(data.sessions)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const row = value as PersistedTokenSessionEntry;
    const daily: Record<string, TokenCounters> = {};
    const providers: Record<string, TokenProviderEntry> = {};

    if (row.daily && typeof row.daily === 'object') {
      for (const [key, item] of Object.entries(row.daily)) {
        daily[key] = readCounters(item);
      }
    }
    if (row.providers && typeof row.providers === 'object') {
      for (const [key, item] of Object.entries(row.providers)) {
        const entry = readProviderEntry(item);
        if (entry) {
          providers[key] = entry;
        }
      }
    }

    out.set(sessionId, {
      sessionId,
      updatedAt: Number((row as { updatedAt?: unknown }).updatedAt) || 0,
      alltime: readCounters(row.alltime),
      daily,
      providers
    });
  }
  return out;
}

function buildCurrentSessionEntry(): PersistedTokenSessionEntry {
  return {
    sessionId: currentSessionId,
    updatedAt: Date.now(),
    alltime: cloneCounters(tokenAlltime),
    daily: cloneDailyMap(tokenDaily),
    providers: cloneProviderMap(tokenByProvider)
  };
}

function buildPersistedSnapshot(existingSessions?: Map<string, PersistedTokenSessionEntry>): PersistedTokenStats {
  const sessions = new Map<string, PersistedTokenSessionEntry>(existingSessions ?? persistedSessions);
  sessions.set(currentSessionId, buildCurrentSessionEntry());
  const sessionsRecord: Record<string, PersistedTokenSessionEntry> = {};
  for (const [key, value] of sessions.entries()) {
    sessionsRecord[key] = {
      sessionId: value.sessionId,
      updatedAt: value.updatedAt,
      alltime: cloneCounters(value.alltime),
      daily: Object.fromEntries(
        Object.entries(value.daily ?? {}).map(([dayKey, counters]) => [dayKey, cloneCounters(counters)])
      ),
      providers: Object.fromEntries(
        Object.entries(value.providers ?? {}).map(([providerKey, entry]) => [providerKey, { ...entry, ...cloneCounters(entry) }])
      )
    };
  }
  return {
    version: 2,
    sessions: sessionsRecord
  };
}

function refreshFromDiskIfNeeded(force = false): void {
  if (!initialized) {
    return;
  }
  const now = Date.now();
  if (!force && now - lastRefreshAtMs < REFRESH_THROTTLE_MS) {
    return;
  }
  lastRefreshAtMs = now;
  try {
    const filePath = getFilePath();
    if (!fsSync.existsSync(filePath)) {
      persistedSessions.clear();
      return;
    }
    const raw = fsSync.readFileSync(filePath, 'utf-8');
    persistedSessions = parsePersistedTokenStats(raw);
  } catch (error) {
    warnSaveFailure(error, 'load');
  }
}

function mergeExternalSessionsForWrite(): Map<string, PersistedTokenSessionEntry> {
  refreshFromDiskIfNeeded(true);
  const merged = new Map<string, PersistedTokenSessionEntry>();
  for (const [key, value] of persistedSessions.entries()) {
    if (key === currentSessionId) {
      continue;
    }
    merged.set(key, value);
  }
  return merged;
}

function aggregateSnapshot(): TokenStatsSnapshot {
  const today = getTodayKey();
  const alltime = emptyCounters();
  const daily = emptyCounters();
  const providers = new Map<string, TokenProviderEntry>();

  const mergeProviders = (source: Record<string, TokenProviderEntry> | Map<string, TokenProviderEntry>): void => {
    const entries = source instanceof Map ? Array.from(source.entries()) : Object.entries(source);
    for (const [key, rawValue] of entries) {
      const value = source instanceof Map ? rawValue : readProviderEntry(rawValue);
      if (!value) {
        continue;
      }
      const existing = providers.get(key) ?? {
        providerKey: value.providerKey,
        model: value.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0
      };
      accumulateCounters(existing, value);
      providers.set(key, existing);
    }
  };

  for (const [sessionId, entry] of persistedSessions.entries()) {
    if (sessionId === currentSessionId) {
      continue;
    }
    accumulateCounters(alltime, entry.alltime);
    if (entry.daily?.[today]) {
      accumulateCounters(daily, entry.daily[today]!);
    }
    mergeProviders(entry.providers ?? {});
  }

  accumulateCounters(alltime, tokenAlltime);
  const currentDaily = tokenDaily.get(today);
  if (currentDaily) {
    accumulateCounters(daily, currentDaily);
  }
  mergeProviders(tokenByProvider);

  return {
    alltime,
    daily,
    dailyDate: today,
    providers: Array.from(providers.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  };
}

// ── Load / Save ────────────────────────────────────────────────────

function ensureLoaded(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  refreshFromDiskIfNeeded(true);
  pruneOldDailyEntries();
}

async function writeSnapshotToDiskAsync(payload: PersistedTokenStats): Promise<void> {
  try {
    const filePath = getFilePath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    warnSaveFailure(error, 'save');
    throw error;
  }
}

function writeSnapshotToDiskSync(payload: PersistedTokenStats): void {
  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fsSync.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fsSync.renameSync(tempPath, filePath);
}

function clearFlushTimer(): void {
  if (!flushTimer) {
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = undefined;
}

function ensureExitHooksBound(): void {
  if (exitHookBound) {
    return;
  }
  exitHookBound = true;
  beforeExitHook = () => saveToDiskSync(true);
  exitHook = () => saveToDiskSync(true);
  process.once('beforeExit', beforeExitHook);
  process.once('exit', exitHook);
}

function computeFlushDelayMs(now = Date.now()): number {
  const elapsedMs = now - lastSaveAtMs;
  return elapsedMs >= SAVE_THROTTLE_MS ? 0 : (SAVE_THROTTLE_MS - elapsedMs);
}

function resolveScheduledFlushDelayMs(): number {
  if (lastSaveAtMs <= 0) {
    return SAVE_THROTTLE_MS;
  }
  return computeFlushDelayMs();
}

function scheduleFlush(delayMs = resolveScheduledFlushDelayMs()): void {
  ensureExitHooksBound();
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void saveToDiskAsync();
  }, Math.max(0, delayMs));
  flushTimer.unref?.();
}

async function saveToDiskAsync(force = false): Promise<void> {
  if (!dirty && !force) {
    return;
  }
  if (flushInFlight) {
    if (dirty || force) {
      pendingFlushAfterCurrent = true;
    }
    return flushInFlight;
  }
  const delayMs = force ? 0 : computeFlushDelayMs();
  if (delayMs > 0) {
    scheduleFlush(delayMs);
    return;
  }
  clearFlushTimer();
  const payload = buildPersistedSnapshot(mergeExternalSessionsForWrite());
  dirty = false;
  flushInFlight = writeSnapshotToDiskAsync(payload)
    .then(() => {
      lastSaveAtMs = Date.now();
      persistedSessions = parsePersistedTokenStats(JSON.stringify(payload));
    })
    .catch(() => {
      dirty = true;
    })
    .finally(() => {
      flushInFlight = null;
      const needsAnotherFlush = dirty || pendingFlushAfterCurrent;
      pendingFlushAfterCurrent = false;
      if (needsAnotherFlush) {
        scheduleFlush();
      }
    });
  return flushInFlight;
}

function saveToDiskSync(force = false): void {
  if (!dirty && !force) {
    return;
  }
  clearFlushTimer();
  const payload = buildPersistedSnapshot(mergeExternalSessionsForWrite());
  try {
    writeSnapshotToDiskSync(payload);
    dirty = false;
    lastSaveAtMs = Date.now();
    persistedSessions = parsePersistedTokenStats(JSON.stringify(payload));
  } catch (error) {
    dirty = true;
    warnSaveFailure(error, 'save');
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Record token consumption for a completed request.
 * Updates alltime, daily, and per-provider counters, then persists (throttled).
 */
export function recordTokens(
  providerKey: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  cacheReadTokens?: number
): void {
  ensureLoaded();
  ensureExitHooksBound();

  const pk = (typeof providerKey === 'string' && providerKey.trim()) ? providerKey.trim() : 'unknown-provider';
  const m = (typeof model === 'string' && model.trim()) ? model.trim() : '-';
  const p = Math.max(0, Math.floor(promptTokens));
  const c = Math.max(0, Math.floor(completionTokens));
  const t = Math.max(0, Math.floor(totalTokens > 0 ? totalTokens : (promptTokens + completionTokens)));
  const cr = Math.max(0, Math.floor(cacheReadTokens ?? 0));
  if (p === 0 && c === 0 && t === 0) {
    return;
  }

  tokenAlltime.promptTokens += p;
  tokenAlltime.completionTokens += c;
  tokenAlltime.totalTokens += t;
  tokenAlltime.cacheReadTokens += cr;

  const today = getTodayKey();
  const day = tokenDaily.get(today) ?? emptyCounters();
  day.promptTokens += p;
  day.completionTokens += c;
  day.totalTokens += t;
  day.cacheReadTokens += cr;
  tokenDaily.set(today, day);

  const key = providerMapKey(pk, m);
  const entry = tokenByProvider.get(key) ?? {
    providerKey: pk,
    model: m,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0
  };
  entry.promptTokens += p;
  entry.completionTokens += c;
  entry.totalTokens += t;
  entry.cacheReadTokens += cr;
  tokenByProvider.set(key, entry);

  dirty = true;
  if (flushInFlight) {
    pendingFlushAfterCurrent = true;
    return;
  }
  scheduleFlush();
}

/**
 * Return cumulative alltime + daily token totals (for [usage] log line).
 */
export function getTokenTotals(): { alltimeTokens: number; dailyTokens: number } {
  ensureLoaded();
  refreshFromDiskIfNeeded();
  const snapshot = aggregateSnapshot();
  return {
    alltimeTokens: snapshot.alltime.totalTokens,
    dailyTokens: snapshot.daily.totalTokens
  };
}

/**
 * Return full token stats snapshot (for /daemon/stats API and rollup display).
 */
export function getTokenStatsSnapshot(): TokenStatsSnapshot {
  ensureLoaded();
  refreshFromDiskIfNeeded();
  return aggregateSnapshot();
}

/**
 * Force save to disk (for graceful shutdown / tests).
 */
export function flushTokenStats(): void {
  saveToDiskSync(true);
}

/**
 * Reset all state (for tests only).
 */
export function __resetTokenStatsForTest(): void {
  tokenAlltime = emptyCounters();
  tokenDaily.clear();
  tokenByProvider.clear();
  persistedSessions.clear();
  initialized = false;
  dirty = false;
  lastSaveAtMs = 0;
  lastRefreshAtMs = 0;
  clearFlushTimer();
  flushInFlight = null;
  pendingFlushAfterCurrent = false;
  if (beforeExitHook) {
    process.off('beforeExit', beforeExitHook);
    beforeExitHook = undefined;
  }
  if (exitHook) {
    process.off('exit', exitHook);
    exitHook = undefined;
  }
  exitHookBound = false;
}
