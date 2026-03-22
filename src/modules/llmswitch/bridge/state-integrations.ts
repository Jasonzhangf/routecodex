/**
 * State Integrations Bridge
 *
 * Sticky session state, session identifier extraction, stats center, and
 * clock task store compatibility wrappers.
 */

import { importCoreDist, requireCoreDist } from './module-loader.js';
import type { AnyRecord } from './module-loader.js';

type StickySessionStoreExports = {
  loadRoutingInstructionStateSync?: (key: string) => unknown | null;
  saveRoutingInstructionStateAsync?: (key: string, state: unknown | null) => void;
  saveRoutingInstructionStateSync?: (key: string, state: unknown | null) => void;
};

let cachedStickySessionStore: StickySessionStoreExports | null | undefined = undefined;

function getStickySessionStoreExports(): StickySessionStoreExports | null {
  if (cachedStickySessionStore !== undefined) {
    return cachedStickySessionStore;
  }
  try {
    cachedStickySessionStore = requireCoreDist<StickySessionStoreExports>('router/virtual-router/sticky-session-store');
  } catch {
    cachedStickySessionStore = null;
  }
  return cachedStickySessionStore;
}

export function loadRoutingInstructionStateSync(key: string): unknown | null {
  const mod = getStickySessionStoreExports();
  const fn = mod?.loadRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    return null;
  }
  return fn(key);
}

export function saveRoutingInstructionStateAsync(key: string, state: unknown | null): void {
  const mod = getStickySessionStoreExports();
  const fn = mod?.saveRoutingInstructionStateAsync;
  if (typeof fn !== 'function') {
    return;
  }
  fn(key, state);
}

export function saveRoutingInstructionStateSync(key: string, state: unknown | null): void {
  const mod = getStickySessionStoreExports();
  const fn = mod?.saveRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    return;
  }
  fn(key, state);
}

type SessionIdentifiers = { sessionId?: string; conversationId?: string };

type SessionIdentifiersModule = {
  extractSessionIdentifiersFromMetadata?: (meta: Record<string, unknown> | undefined) => SessionIdentifiers;
};

let cachedSessionIdentifiersModule: SessionIdentifiersModule | null | undefined = undefined;

function getSessionIdentifiersModule(): SessionIdentifiersModule | null {
  if (cachedSessionIdentifiersModule !== undefined) {
    return cachedSessionIdentifiersModule;
  }
  try {
    cachedSessionIdentifiersModule = requireCoreDist<SessionIdentifiersModule>('conversion/hub/pipeline/session-identifiers');
  } catch {
    cachedSessionIdentifiersModule = null;
  }
  return cachedSessionIdentifiersModule;
}

export function extractSessionIdentifiersFromMetadata(meta: Record<string, unknown> | undefined): SessionIdentifiers {
  const mod = getSessionIdentifiersModule();
  const fn = mod?.extractSessionIdentifiersFromMetadata;
  if (typeof fn !== 'function') {
    return {};
  }
  try {
    return fn(meta);
  } catch {
    return {};
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
    return { recordProviderUsage: () => {} };
  }
  try {
    const mod = requireCoreDist<StatsCenterModule>('telemetry/stats-center');
    const fn = mod?.getStatsCenter;
    const center = typeof fn === 'function' ? fn() : null;
    if (center && typeof center.recordProviderUsage === 'function') {
      cachedStatsCenter = center;
      return center;
    }
  } catch {
    // fall through
  }
  cachedStatsCenter = null;
  return { recordProviderUsage: () => {} };
}

export function getLlmsStatsSnapshot(): unknown | null {
  try {
    const mod = requireCoreDist<{ getStatsCenter?: () => { getSnapshot?: () => unknown } }>('telemetry/stats-center');
    const get = mod?.getStatsCenter;
    const center = typeof get === 'function' ? get() : null;
    const snap = center && typeof center === 'object' ? (center as any).getSnapshot : null;
    return typeof snap === 'function' ? snap.call(center) : null;
  } catch {
    return null;
  }
}

type ClockTaskStoreModule = {
  resolveClockConfig?: (input: unknown) => unknown | null;
  startClockDaemonIfNeeded?: (config: unknown) => Promise<void> | void;
  setClockRuntimeHooks?: (hooks?: {
    isTmuxSessionAlive?: (tmuxSessionId: string) => Promise<boolean> | boolean;
    dispatchDueTask?: (request: {
      sessionId: string;
      tmuxSessionId: string;
      task: unknown;
      injectText: string;
    }) => Promise<{ ok: boolean; cleanupSession?: boolean; reason?: string } | null> | { ok: boolean; cleanupSession?: boolean; reason?: string } | null;
  }) => void | Promise<void>;
  reserveDueTasksForRequest?: (args: {
    reservationId: string;
    sessionId: string;
    config: unknown;
    requestId?: string;
  }) => Promise<{ reservation: unknown | null; injectText?: string }>;
  commitClockReservation?: (reservation: unknown, config: unknown) => Promise<void>;
  listClockSessionIds?: () => Promise<string[]>;
  listClockTasks?: (sessionId: string, config: unknown) => Promise<unknown[]>;
  scheduleClockTasks?: (sessionId: string, items: unknown[], config: unknown) => Promise<unknown[]>;
  updateClockTask?: (sessionId: string, taskId: string, patch: Record<string, unknown>, config: unknown) => Promise<unknown | null>;
  cancelClockTask?: (sessionId: string, taskId: string, config: unknown) => Promise<boolean>;
  clearClockTasks?: (sessionId: string, config: unknown) => Promise<number>;
};

type HeartbeatTaskStoreModule = {
  buildHeartbeatInjectText?: () => string;
  resolveHeartbeatConfig?: (input: unknown) => unknown | null;
  startHeartbeatDaemonIfNeeded?: (config: unknown) => Promise<void> | void;
  setHeartbeatRuntimeHooks?: (hooks?: {
    isTmuxSessionAlive?: (tmuxSessionId: string) => Promise<boolean> | boolean;
    dispatchHeartbeat?: (request: {
      tmuxSessionId: string;
      state: unknown;
      injectText: string;
    }) => Promise<{ ok: boolean; skipped?: boolean; disable?: boolean; reason?: string } | null> | { ok: boolean; skipped?: boolean; disable?: boolean; reason?: string } | null;
  }) => void | Promise<void>;
  loadHeartbeatState?: (tmuxSessionId: string) => Promise<unknown>;
  listHeartbeatStates?: () => Promise<unknown[]>;
  setHeartbeatEnabled?: (
    tmuxSessionId: string,
    enabled: boolean,
    options?: {
      intervalMs?: number;
      clearIntervalOverride?: boolean;
      source?: string;
      reason?: string;
      details?: Record<string, unknown>;
    }
  ) => Promise<unknown>;
  listHeartbeatHistory?: (args: { tmuxSessionId: string; limit?: number }) => Promise<unknown[]>;
  appendHeartbeatHistoryEvent?: (input: {
    tmuxSessionId: string;
    source: string;
    action: string;
    outcome: string;
    reason?: string;
    details?: Record<string, unknown>;
    atMs?: number;
  }) => Promise<boolean>;
  runHeartbeatDaemonTickForTests?: () => Promise<void>;
};

type ClockTaskStoreLegacyTasksModule = Pick<ClockTaskStoreModule,
  | 'reserveDueTasksForRequest'
  | 'commitClockReservation'
  | 'listClockSessionIds'
  | 'listClockTasks'
  | 'scheduleClockTasks'
  | 'updateClockTask'
  | 'cancelClockTask'
  | 'clearClockTasks'
>;

type ClockTaskStoreLegacyConfigModule = Pick<ClockTaskStoreModule, 'resolveClockConfig'>;

let cachedClockTaskStoreModule: ClockTaskStoreModule | null | undefined = undefined;
let clockTaskStoreLastLoadAttemptAtMs = 0;
let hasLoggedClockTaskStoreLoadFailure = false;
let cachedHeartbeatTaskStoreModule: HeartbeatTaskStoreModule | null | undefined = undefined;
let heartbeatTaskStoreLastLoadAttemptAtMs = 0;
let hasLoggedHeartbeatTaskStoreLoadFailure = false;

const CLOCK_TASK_STORE_RETRY_INTERVAL_MS = 30_000;

async function tryLoadClockTaskStoreModule(): Promise<ClockTaskStoreModule | null> {
  try {
    return await importCoreDist<ClockTaskStoreModule>('servertool/clock/task-store');
  } catch {
    // fallback to legacy split exports
  }

  try {
    const [tasksModule, configModule] = await Promise.all([
      importCoreDist<ClockTaskStoreLegacyTasksModule>('servertool/clock/tasks'),
      importCoreDist<ClockTaskStoreLegacyConfigModule>('servertool/clock/config')
    ]);
    return { ...tasksModule, resolveClockConfig: configModule.resolveClockConfig };
  } catch {
    return null;
  }
}

async function getClockTaskStoreModuleSafe(): Promise<ClockTaskStoreModule | null> {
  if (cachedClockTaskStoreModule) {
    return cachedClockTaskStoreModule;
  }

  const now = Date.now();
  if (cachedClockTaskStoreModule === null && now - clockTaskStoreLastLoadAttemptAtMs < CLOCK_TASK_STORE_RETRY_INTERVAL_MS) {
    return null;
  }

  clockTaskStoreLastLoadAttemptAtMs = now;
  const loaded = await tryLoadClockTaskStoreModule();
  if (loaded) {
    cachedClockTaskStoreModule = loaded;
    hasLoggedClockTaskStoreLoadFailure = false;
    return loaded;
  }

  cachedClockTaskStoreModule = null;
  if (!hasLoggedClockTaskStoreLoadFailure) {
    hasLoggedClockTaskStoreLoadFailure = true;
    console.warn(
      '[llmswitch-bridge] clock task-store module unavailable; session daemon inject/tasks are temporarily disabled.'
    );
  }

  return null;
}

async function tryLoadHeartbeatTaskStoreModule(): Promise<HeartbeatTaskStoreModule | null> {
  try {
    return await importCoreDist<HeartbeatTaskStoreModule>('servertool/heartbeat/task-store');
  } catch {
    return null;
  }
}

async function getHeartbeatTaskStoreModuleSafe(): Promise<HeartbeatTaskStoreModule | null> {
  if (cachedHeartbeatTaskStoreModule) {
    return cachedHeartbeatTaskStoreModule;
  }

  const now = Date.now();
  if (
    cachedHeartbeatTaskStoreModule === null &&
    now - heartbeatTaskStoreLastLoadAttemptAtMs < CLOCK_TASK_STORE_RETRY_INTERVAL_MS
  ) {
    return null;
  }

  heartbeatTaskStoreLastLoadAttemptAtMs = now;
  const loaded = await tryLoadHeartbeatTaskStoreModule();
  if (loaded) {
    cachedHeartbeatTaskStoreModule = loaded;
    hasLoggedHeartbeatTaskStoreLoadFailure = false;
    return loaded;
  }

  cachedHeartbeatTaskStoreModule = null;
  if (!hasLoggedHeartbeatTaskStoreLoadFailure) {
    hasLoggedHeartbeatTaskStoreLoadFailure = true;
    console.warn(
      '[llmswitch-bridge] heartbeat task-store module unavailable; heartbeat daemon features are temporarily disabled.'
    );
  }
  return null;
}

export async function resolveClockConfigSnapshot(input: unknown): Promise<unknown | null> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.resolveClockConfig;
  if (typeof fn !== 'function') return null;
  try {
    return fn(input) ?? null;
  } catch {
    return null;
  }
}

export async function setClockRuntimeHooksSnapshot(hooks?: {
  isTmuxSessionAlive?: (tmuxSessionId: string) => Promise<boolean> | boolean;
  dispatchDueTask?: (request: {
    sessionId: string;
    tmuxSessionId: string;
    task: unknown;
    injectText: string;
  }) => Promise<{ ok: boolean; cleanupSession?: boolean; reason?: string } | null> | { ok: boolean; cleanupSession?: boolean; reason?: string } | null;
}): Promise<boolean> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.setClockRuntimeHooks;
  if (typeof fn !== 'function') {
    return false;
  }
  try {
    await fn(hooks);
    return true;
  } catch {
    return false;
  }
}

export async function startClockDaemonIfNeededSnapshot(config: unknown): Promise<boolean> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.startClockDaemonIfNeeded;
  if (typeof fn !== 'function') {
    return false;
  }
  try {
    await fn(config);
    return true;
  } catch {
    return false;
  }
}

export async function reserveClockDueTasks(args: {
  reservationId: string;
  sessionId: string;
  config: unknown;
  requestId?: string;
}): Promise<{ reservation: unknown | null; injectText?: string }> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.reserveDueTasksForRequest;
  if (typeof fn !== 'function') return { reservation: null };
  try {
    return await fn(args);
  } catch {
    return { reservation: null };
  }
}

export async function commitClockDueReservation(args: { reservation: unknown; config: unknown }): Promise<void> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.commitClockReservation;
  if (typeof fn !== 'function') return;
  try {
    await fn(args.reservation, args.config);
  } catch {
    // best-effort only
  }
}

export async function listClockSessionIdsSnapshot(): Promise<string[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockSessionIds;
  if (typeof fn !== 'function') return [];
  try {
    const out = await fn();
    return Array.isArray(out)
      ? out.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
  } catch {
    return [];
  }
}

export async function listClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<unknown[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockTasks;
  if (typeof fn !== 'function') return [];
  try {
    const out = await fn(args.sessionId, args.config);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

export async function scheduleClockTasksSnapshot(args: {
  sessionId: string;
  items: unknown[];
  config: unknown;
}): Promise<unknown[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.scheduleClockTasks;
  if (typeof fn !== 'function') return [];
  try {
    const out = await fn(args.sessionId, Array.isArray(args.items) ? args.items : [], args.config);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

export async function updateClockTaskSnapshot(args: {
  sessionId: string;
  taskId: string;
  patch: Record<string, unknown>;
  config: unknown;
}): Promise<unknown | null> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.updateClockTask;
  if (typeof fn !== 'function') return null;
  try {
    return await fn(args.sessionId, args.taskId, args.patch, args.config);
  } catch {
    return null;
  }
}

export async function cancelClockTaskSnapshot(args: {
  sessionId: string;
  taskId: string;
  config: unknown;
}): Promise<boolean> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.cancelClockTask;
  if (typeof fn !== 'function') return false;
  try {
    return Boolean(await fn(args.sessionId, args.taskId, args.config));
  } catch {
    return false;
  }
}

export async function clearClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<number> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.clearClockTasks;
  if (typeof fn !== 'function') return 0;
  try {
    const removed = await fn(args.sessionId, args.config);
    return Number.isFinite(Number(removed)) ? Math.max(0, Math.floor(Number(removed))) : 0;
  } catch {
    return 0;
  }
}

export async function resolveHeartbeatConfigSnapshot(input: unknown): Promise<unknown | null> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.resolveHeartbeatConfig;
  if (typeof fn !== 'function') return null;
  try {
    return fn(input) ?? null;
  } catch {
    return null;
  }
}

export async function buildHeartbeatInjectTextSnapshot(): Promise<string | null> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.buildHeartbeatInjectText;
  if (typeof fn !== 'function') return null;
  try {
    const text = fn();
    return typeof text === 'string' && text.trim() ? text : null;
  } catch {
    return null;
  }
}

export async function setHeartbeatRuntimeHooksSnapshot(hooks?: {
  isTmuxSessionAlive?: (tmuxSessionId: string) => Promise<boolean> | boolean;
  dispatchHeartbeat?: (request: {
    tmuxSessionId: string;
    state: unknown;
    injectText: string;
  }) => Promise<{ ok: boolean; skipped?: boolean; disable?: boolean; reason?: string } | null> | { ok: boolean; skipped?: boolean; disable?: boolean; reason?: string } | null;
}): Promise<boolean> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.setHeartbeatRuntimeHooks;
  if (typeof fn !== 'function') {
    return false;
  }
  try {
    await fn(hooks);
    return true;
  } catch {
    return false;
  }
}

export async function startHeartbeatDaemonIfNeededSnapshot(config: unknown): Promise<boolean> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.startHeartbeatDaemonIfNeeded;
  if (typeof fn !== 'function') {
    return false;
  }
  try {
    await fn(config);
    return true;
  } catch {
    return false;
  }
}

export async function loadHeartbeatStateSnapshot(tmuxSessionId: string): Promise<unknown | null> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.loadHeartbeatState;
  if (typeof fn !== 'function') return null;
  try {
    return await fn(tmuxSessionId);
  } catch {
    return null;
  }
}

export async function listHeartbeatStatesSnapshot(): Promise<unknown[]> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.listHeartbeatStates;
  if (typeof fn !== 'function') return [];
  try {
    const out = await fn();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

export async function setHeartbeatEnabledSnapshot(args: {
  tmuxSessionId: string;
  enabled: boolean;
  source?: string;
  reason?: string;
  intervalMs?: number;
  clearIntervalOverride?: boolean;
  details?: Record<string, unknown>;
}): Promise<unknown | null> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.setHeartbeatEnabled;
  if (typeof fn !== 'function') return null;
  try {
    return await fn(args.tmuxSessionId, args.enabled, {
      ...(typeof args.intervalMs === 'number' ? { intervalMs: args.intervalMs } : {}),
      ...(args.clearIntervalOverride ? { clearIntervalOverride: true } : {}),
      ...(typeof args.source === 'string' && args.source.trim() ? { source: args.source.trim() } : {}),
      ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}),
      ...(args.details && typeof args.details === 'object' ? { details: args.details } : {})
    });
  } catch {
    return null;
  }
}

export async function listHeartbeatHistorySnapshot(args: {
  tmuxSessionId: string;
  limit?: number;
}): Promise<unknown[]> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.listHeartbeatHistory;
  if (typeof fn !== 'function') {
    return [];
  }
  try {
    const out = await fn(args);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

export async function appendHeartbeatHistoryEventSnapshot(input: {
  tmuxSessionId: string;
  source: string;
  action: string;
  outcome: string;
  reason?: string;
  details?: Record<string, unknown>;
  atMs?: number;
}): Promise<boolean> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.appendHeartbeatHistoryEvent;
  if (typeof fn !== 'function') {
    return false;
  }
  try {
    return Boolean(await fn(input));
  } catch {
    return false;
  }
}

export async function runHeartbeatDaemonTickSnapshot(): Promise<boolean> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.runHeartbeatDaemonTickForTests;
  if (typeof fn !== 'function') {
    return false;
  }
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}
