/**
 * Token Statistics Store
 *
 * Tracks alltime, daily, and per-provider token consumption.
 * Persists to ~/.rcc/token-stats.json (throttled, survives restarts).
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

interface PersistedTokenStats {
  version: number;
  alltime: TokenCounters;
  daily: Record<string, TokenCounters>;
  providers: Record<string, TokenProviderEntry>;
}

// ── State ──────────────────────────────────────────────────────────

let tokenAlltime: TokenCounters = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
let tokenDaily = new Map<string, TokenCounters>();
let tokenByProvider = new Map<string, TokenProviderEntry>();
let initialized = false;
let dirty = false;
let lastSaveAtMs = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushInFlight: Promise<void> | null = null;
let pendingFlushAfterCurrent = false;
let exitHookBound = false;
let beforeExitHook: (() => void) | undefined;
let exitHook: (() => void) | undefined;
const SAVE_THROTTLE_MS = 10_000;

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
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function buildPersistedSnapshot(): PersistedTokenStats {
  const dailyObj: Record<string, TokenCounters> = {};
  for (const [k, v] of tokenDaily.entries()) {
    dailyObj[k] = { ...v };
  }
  const providersObj: Record<string, TokenProviderEntry> = {};
  for (const [k, v] of tokenByProvider.entries()) {
    providersObj[k] = { ...v };
  }
  return {
    version: 1,
    alltime: { ...tokenAlltime },
    daily: dailyObj,
    providers: providersObj
  };
}

function pruneOldDailyEntries(): void {
  // Keep last 30 days only
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [key] of tokenDaily) {
    // key is "YYYY-MM-DD"
    const parts = key.split('-');
    if (parts.length === 3) {
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (d.getTime() < cutoff) {
        tokenDaily.delete(key);
      }
    }
  }
}

// ── Load / Save ────────────────────────────────────────────────────

function ensureLoaded(): void {
  if (initialized) return;
  initialized = true;
  try {
    const filePath = getFilePath();
    if (!fsSync.existsSync(filePath)) return;
    const raw = fsSync.readFileSync(filePath, 'utf-8');
    const data: PersistedTokenStats = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;

    tokenAlltime = {
      promptTokens: Number(data.alltime?.promptTokens) || 0,
      completionTokens: Number(data.alltime?.completionTokens) || 0,
      totalTokens: Number(data.alltime?.totalTokens) || 0,
    };

    if (data.daily && typeof data.daily === 'object') {
      for (const [k, v] of Object.entries(data.daily)) {
        if (v && typeof v === 'object') {
          tokenDaily.set(k, {
            promptTokens: Number((v as TokenCounters).promptTokens) || 0,
            completionTokens: Number((v as TokenCounters).completionTokens) || 0,
            totalTokens: Number((v as TokenCounters).totalTokens) || 0,
          });
        }
      }
    }

    if (data.providers && typeof data.providers === 'object') {
      for (const [k, v] of Object.entries(data.providers)) {
        if (v && typeof v === 'object') {
          tokenByProvider.set(k, {
            providerKey: String((v as TokenProviderEntry).providerKey) || '',
            model: String((v as TokenProviderEntry).model) || '',
            promptTokens: Number((v as TokenProviderEntry).promptTokens) || 0,
            completionTokens: Number((v as TokenProviderEntry).completionTokens) || 0,
            totalTokens: Number((v as TokenProviderEntry).totalTokens) || 0,
          });
        }
      }
    }

    pruneOldDailyEntries();
  } catch (error) {
    warnSaveFailure(error, 'load');
  }
}

function warnSaveFailure(error: unknown, phase: 'load' | 'save'): void {
  console.warn(
    `[token-stats] Failed to ${phase}: ${error instanceof Error ? error.message : String(error)}`
  );
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
  const payload = buildPersistedSnapshot();
  dirty = false;
  flushInFlight = writeSnapshotToDiskAsync(payload)
    .then(() => {
      lastSaveAtMs = Date.now();
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
  const payload = buildPersistedSnapshot();
  try {
    writeSnapshotToDiskSync(payload);
    dirty = false;
    lastSaveAtMs = Date.now();
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
  totalTokens: number
): void {
  ensureLoaded();
  ensureExitHooksBound();

  const pk = (typeof providerKey === 'string' && providerKey.trim()) ? providerKey.trim() : 'unknown-provider';
  const m = (typeof model === 'string' && model.trim()) ? model.trim() : '-';
  const p = Math.max(0, Math.floor(promptTokens));
  const c = Math.max(0, Math.floor(completionTokens));
  const t = Math.max(0, Math.floor(totalTokens > 0 ? totalTokens : (promptTokens + completionTokens)));
  if (p === 0 && c === 0 && t === 0) return;

  // Alltime
  tokenAlltime.promptTokens += p;
  tokenAlltime.completionTokens += c;
  tokenAlltime.totalTokens += t;

  // Daily
  const today = getTodayKey();
  const day = tokenDaily.get(today) ?? emptyCounters();
  day.promptTokens += p;
  day.completionTokens += c;
  day.totalTokens += t;
  tokenDaily.set(today, day);

  // Per-provider
  const key = providerMapKey(pk, m);
  const entry = tokenByProvider.get(key) ?? {
    providerKey: pk,
    model: m,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  entry.promptTokens += p;
  entry.completionTokens += c;
  entry.totalTokens += t;
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
  const today = getTodayKey();
  const daily = tokenDaily.get(today);
  return {
    alltimeTokens: tokenAlltime.totalTokens,
    dailyTokens: daily?.totalTokens ?? 0,
  };
}

/**
 * Return full token stats snapshot (for /daemon/stats API and rollup display).
 */
export function getTokenStatsSnapshot(): TokenStatsSnapshot {
  ensureLoaded();
  const today = getTodayKey();
  const daily = tokenDaily.get(today) ?? emptyCounters();
  return {
    alltime: { ...tokenAlltime },
    daily: { ...daily },
    dailyDate: today,
    providers: Array.from(tokenByProvider.values()).sort(
      (a, b) => b.totalTokens - a.totalTokens
    ),
  };
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
  initialized = false;
  dirty = false;
  lastSaveAtMs = 0;
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
