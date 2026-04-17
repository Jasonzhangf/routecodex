/**
 * State Integrations Bridge
 *
 * Sticky session state, session identifier extraction, stats center, and
 * clock task store compatibility wrappers.
 */

import { importCoreDist, requireCoreDist } from './module-loader.js';
import type { AnyRecord } from './module-loader.js';

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logStateIntegrationsNonBlocking(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[llmswitch-bridge.state-integrations] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

const NOOP_STATS_CENTER: StatsCenterLike = {
  recordProviderUsage: () => {}
};

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
  } catch (error) {
    logStateIntegrationsNonBlocking('sticky_session_store.load', error);
    cachedStickySessionStore = null;
  }
  return cachedStickySessionStore;
}

export function loadRoutingInstructionStateSync(key: string): unknown | null {
  const mod = getStickySessionStoreExports();
  const fn = mod?.loadRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('sticky_session_store.load_state.api_unavailable', 'loadRoutingInstructionStateSync not available');
    }
    return null;
  }
  try {
    return fn(key);
  } catch (error) {
    logStateIntegrationsNonBlocking('sticky_session_store.load_state.invoke', error, { key });
    return null;
  }
}

export function saveRoutingInstructionStateAsync(key: string, state: unknown | null): void {
  const mod = getStickySessionStoreExports();
  const fn = mod?.saveRoutingInstructionStateAsync;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('sticky_session_store.save_async.api_unavailable', 'saveRoutingInstructionStateAsync not available');
    }
    return;
  }
  try {
    fn(key, state);
  } catch (error) {
    logStateIntegrationsNonBlocking('sticky_session_store.save_async.invoke', error, { key });
  }
}

export function saveRoutingInstructionStateSync(key: string, state: unknown | null): void {
  const mod = getStickySessionStoreExports();
  const fn = mod?.saveRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('sticky_session_store.save_sync.api_unavailable', 'saveRoutingInstructionStateSync not available');
    }
    return;
  }
  try {
    fn(key, state);
  } catch (error) {
    logStateIntegrationsNonBlocking('sticky_session_store.save_sync.invoke', error, { key });
  }
}

type ReasoningStopStateExports = {
  syncReasoningStopModeFromRequest?: (
    adapterContext: unknown,
    fallbackMode?: 'on' | 'off' | 'endless'
  ) => 'on' | 'off' | 'endless';
};

let cachedReasoningStopStateModule: ReasoningStopStateExports | null | undefined = undefined;

function getReasoningStopStateExports(): ReasoningStopStateExports | null {
  if (cachedReasoningStopStateModule !== undefined) {
    return cachedReasoningStopStateModule;
  }
  try {
    cachedReasoningStopStateModule = requireCoreDist<ReasoningStopStateExports>(
      'servertool/handlers/reasoning-stop-state'
    );
  } catch (error) {
    logStateIntegrationsNonBlocking('reasoning_stop_state.load', error);
    cachedReasoningStopStateModule = null;
  }
  return cachedReasoningStopStateModule;
}

export function syncReasoningStopModeFromRequest(
  adapterContext: unknown,
  fallbackMode: 'on' | 'off' | 'endless' = 'off'
): 'on' | 'off' | 'endless' {
  const mod = getReasoningStopStateExports();
  const fn = mod?.syncReasoningStopModeFromRequest;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking(
        'reasoning_stop_state.sync_mode.api_unavailable',
        'syncReasoningStopModeFromRequest not available',
        { fallbackMode }
      );
    }
    return fallbackMode;
  }
  try {
    return fn(adapterContext, fallbackMode);
  } catch (error) {
    logStateIntegrationsNonBlocking('reasoning_stop_state.sync_mode.invoke', error, { fallbackMode });
    return fallbackMode;
  }
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
  } catch (error) {
    logStateIntegrationsNonBlocking('session_identifiers.load', error);
    cachedSessionIdentifiersModule = null;
  }
  return cachedSessionIdentifiersModule;
}

export function extractSessionIdentifiersFromMetadata(meta: Record<string, unknown> | undefined): SessionIdentifiers {
  const mod = getSessionIdentifiersModule();
  const fn = mod?.extractSessionIdentifiersFromMetadata;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking(
        'session_identifiers.extract.api_unavailable',
        'extractSessionIdentifiersFromMetadata not available'
      );
    }
    return {};
  }
  try {
    return fn(meta);
  } catch (error) {
    logStateIntegrationsNonBlocking('session_identifiers.extract.invoke', error);
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
    return NOOP_STATS_CENTER;
  }
  try {
    const mod = requireCoreDist<StatsCenterModule>('telemetry/stats-center');
    const fn = mod?.getStatsCenter;
    const center = typeof fn === 'function' ? fn() : null;
    if (center && typeof center.recordProviderUsage === 'function') {
      cachedStatsCenter = center;
      return center;
    }
    logStateIntegrationsNonBlocking('stats_center.api_unavailable', 'getStatsCenter not available');
  } catch (error) {
    logStateIntegrationsNonBlocking('stats_center.load', error);
  }
  cachedStatsCenter = null;
  return NOOP_STATS_CENTER;
}

export function getLlmsStatsSnapshot(): unknown | null {
  try {
    const mod = requireCoreDist<{ getStatsCenter?: () => { getSnapshot?: () => unknown } }>('telemetry/stats-center');
    const get = mod?.getStatsCenter;
    const center = typeof get === 'function' ? get() : null;
    const snap = center && typeof center === 'object' ? (center as any).getSnapshot : null;
    return typeof snap === 'function' ? snap.call(center) : null;
  } catch (error) {
    logStateIntegrationsNonBlocking('stats_center.snapshot', error);
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
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.load.primary', error);
  }

  try {
    const [tasksModule, configModule] = await Promise.all([
      importCoreDist<ClockTaskStoreLegacyTasksModule>('servertool/clock/tasks'),
      importCoreDist<ClockTaskStoreLegacyConfigModule>('servertool/clock/config')
    ]);
    return { ...tasksModule, resolveClockConfig: configModule.resolveClockConfig };
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.load.legacy', error);
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
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.load', error);
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
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.resolve_config.api_unavailable', 'resolveClockConfig not available');
    }
    return null;
  }
  try {
    return fn(input) ?? null;
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.resolve_config.invoke', error);
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
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.set_runtime_hooks.api_unavailable', 'setClockRuntimeHooks not available');
    }
    return false;
  }
  try {
    await fn(hooks);
    return true;
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.set_runtime_hooks.invoke', error);
    return false;
  }
}

export async function startClockDaemonIfNeededSnapshot(config: unknown): Promise<boolean> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.startClockDaemonIfNeeded;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.start_daemon.api_unavailable', 'startClockDaemonIfNeeded not available');
    }
    return false;
  }
  try {
    await fn(config);
    return true;
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.start_daemon.invoke', error);
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
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.reserve_due_tasks.api_unavailable', 'reserveDueTasksForRequest not available');
    }
    return { reservation: null };
  }
  try {
    return await fn(args);
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.reserve_due_tasks.invoke', error, {
      sessionId: args.sessionId,
      requestId: args.requestId
    });
    return { reservation: null };
  }
}

export async function commitClockDueReservation(args: { reservation: unknown; config: unknown }): Promise<void> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.commitClockReservation;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.commit_reservation.api_unavailable', 'commitClockReservation not available');
    }
    return;
  }
  try {
    await fn(args.reservation, args.config);
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.commit_reservation.invoke', error);
  }
}

export async function listClockSessionIdsSnapshot(): Promise<string[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockSessionIds;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.list_session_ids.api_unavailable', 'listClockSessionIds not available');
    }
    return [];
  }
  try {
    const out = await fn();
    return Array.isArray(out)
      ? out.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.list_session_ids.invoke', error);
    return [];
  }
}

export async function listClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<unknown[]> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.listClockTasks;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.list_tasks.api_unavailable', 'listClockTasks not available');
    }
    return [];
  }
  try {
    const out = await fn(args.sessionId, args.config);
    return Array.isArray(out) ? out : [];
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.list_tasks.invoke', error, { sessionId: args.sessionId });
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
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.schedule_tasks.api_unavailable', 'scheduleClockTasks not available');
    }
    return [];
  }
  try {
    const out = await fn(args.sessionId, Array.isArray(args.items) ? args.items : [], args.config);
    return Array.isArray(out) ? out : [];
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.schedule_tasks.invoke', error, { sessionId: args.sessionId });
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
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.update_task.api_unavailable', 'updateClockTask not available');
    }
    return null;
  }
  try {
    return await fn(args.sessionId, args.taskId, args.patch, args.config);
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.update_task.invoke', error, {
      sessionId: args.sessionId,
      taskId: args.taskId
    });
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
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.cancel_task.api_unavailable', 'cancelClockTask not available');
    }
    return false;
  }
  try {
    return Boolean(await fn(args.sessionId, args.taskId, args.config));
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.cancel_task.invoke', error, {
      sessionId: args.sessionId,
      taskId: args.taskId
    });
    return false;
  }
}

export async function clearClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<number> {
  const mod = await getClockTaskStoreModuleSafe();
  const fn = mod?.clearClockTasks;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('clock_task_store.clear_tasks.api_unavailable', 'clearClockTasks not available');
    }
    return 0;
  }
  try {
    const removed = await fn(args.sessionId, args.config);
    return Number.isFinite(Number(removed)) ? Math.max(0, Math.floor(Number(removed))) : 0;
  } catch (error) {
    logStateIntegrationsNonBlocking('clock_task_store.clear_tasks.invoke', error, { sessionId: args.sessionId });
    return 0;
  }
}

export async function resolveHeartbeatConfigSnapshot(input: unknown): Promise<unknown | null> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.resolveHeartbeatConfig;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.resolve_config.api_unavailable', 'resolveHeartbeatConfig not available');
    }
    return null;
  }
  try {
    return fn(input) ?? null;
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.resolve_config.invoke', error);
    return null;
  }
}

export async function buildHeartbeatInjectTextSnapshot(): Promise<string | null> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.buildHeartbeatInjectText;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.build_inject_text.api_unavailable', 'buildHeartbeatInjectText not available');
    }
    return null;
  }
  try {
    const text = fn();
    return typeof text === 'string' && text.trim() ? text : null;
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.build_inject_text.invoke', error);
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
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.set_runtime_hooks.api_unavailable', 'setHeartbeatRuntimeHooks not available');
    }
    return false;
  }
  try {
    await fn(hooks);
    return true;
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.set_runtime_hooks.invoke', error);
    return false;
  }
}

export async function startHeartbeatDaemonIfNeededSnapshot(config: unknown): Promise<boolean> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.startHeartbeatDaemonIfNeeded;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.start_daemon.api_unavailable', 'startHeartbeatDaemonIfNeeded not available');
    }
    return false;
  }
  try {
    await fn(config);
    return true;
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.start_daemon.invoke', error);
    return false;
  }
}

export async function loadHeartbeatStateSnapshot(tmuxSessionId: string): Promise<unknown | null> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.loadHeartbeatState;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.load_state.api_unavailable', 'loadHeartbeatState not available');
    }
    return null;
  }
  try {
    return await fn(tmuxSessionId);
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.load_state.invoke', error, { tmuxSessionId });
    return null;
  }
}

export async function listHeartbeatStatesSnapshot(): Promise<unknown[]> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.listHeartbeatStates;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.list_states.api_unavailable', 'listHeartbeatStates not available');
    }
    return [];
  }
  try {
    const out = await fn();
    return Array.isArray(out) ? out : [];
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.list_states.invoke', error);
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
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.set_enabled.api_unavailable', 'setHeartbeatEnabled not available');
    }
    return null;
  }
  try {
    return await fn(args.tmuxSessionId, args.enabled, {
      ...(typeof args.intervalMs === 'number' ? { intervalMs: args.intervalMs } : {}),
      ...(args.clearIntervalOverride ? { clearIntervalOverride: true } : {}),
      ...(typeof args.source === 'string' && args.source.trim() ? { source: args.source.trim() } : {}),
      ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}),
      ...(args.details && typeof args.details === 'object' ? { details: args.details } : {})
    });
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.set_enabled.invoke', error, {
      tmuxSessionId: args.tmuxSessionId,
      enabled: args.enabled
    });
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
    if (mod) {
      logStateIntegrationsNonBlocking('heartbeat_task_store.list_history.api_unavailable', 'listHeartbeatHistory not available');
    }
    return [];
  }
  try {
    const out = await fn(args);
    return Array.isArray(out) ? out : [];
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.list_history.invoke', error, {
      tmuxSessionId: args.tmuxSessionId
    });
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
    if (mod) {
      logStateIntegrationsNonBlocking(
        'heartbeat_task_store.append_history_event.api_unavailable',
        'appendHeartbeatHistoryEvent not available'
      );
    }
    return false;
  }
  try {
    return Boolean(await fn(input));
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.append_history_event.invoke', error, {
      tmuxSessionId: input.tmuxSessionId,
      source: input.source,
      action: input.action
    });
    return false;
  }
}

export async function runHeartbeatDaemonTickSnapshot(): Promise<boolean> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  const fn = mod?.runHeartbeatDaemonTickForTests;
  if (typeof fn !== 'function') {
    if (mod) {
      logStateIntegrationsNonBlocking(
        'heartbeat_task_store.run_tick.api_unavailable',
        'runHeartbeatDaemonTickForTests not available'
      );
    }
    return false;
  }
  try {
    await fn();
    return true;
  } catch (error) {
    logStateIntegrationsNonBlocking('heartbeat_task_store.run_tick.invoke', error);
    return false;
  }
}
