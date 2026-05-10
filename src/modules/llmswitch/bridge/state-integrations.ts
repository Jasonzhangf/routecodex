/**
 * State Integrations Bridge
 *
 * Sticky session state, session identifier extraction, stats center, and
 * clock task store compatibility wrappers.
 */

import { importCoreDist, requireCoreDist } from './module-loader.js';
import type { AnyRecord } from './module-loader.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';
import {
  extractSessionIdentifiersFromMetadataWithNative
} from '../../../../sharedmodule/llmswitch-core/dist/router/virtual-router/engine-selection/native-hub-pipeline-session-identifiers-semantics.js';
import {
  syncReasoningStopModeFromRequest as syncReasoningStopModeFromRequestFromCore
} from '../../../../sharedmodule/llmswitch-core/dist/servertool/handlers/reasoning-stop-state.js';

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();


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
  const stickySessionStoreModule = requireCoreDist<{
    loadRoutingInstructionStateSync?: (key: string) => unknown | null;
  }>('router/virtual-router/sticky-session-store');
  const fn = stickySessionStoreModule.loadRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    throw buildStateIntegrationFailure(
      'sticky_session_store.load_state.api_unavailable',
      'loadRoutingInstructionStateSync not available',
      { key }
    );
  }
  try {
    return fn(key);
  } catch (error) {
    throw buildStateIntegrationFailure('sticky_session_store.load_state.invoke', error, { key });
  }
}

export function saveRoutingInstructionStateAsync(key: string, state: unknown | null): void {
  const stickySessionStoreModule = requireCoreDist<{
    saveRoutingInstructionStateAsync?: (key: string, state: unknown | null) => void;
  }>('router/virtual-router/sticky-session-store');
  const fn = stickySessionStoreModule.saveRoutingInstructionStateAsync;
  if (typeof fn !== 'function') {
    throw buildStateIntegrationFailure(
      'sticky_session_store.save_async.api_unavailable',
      'saveRoutingInstructionStateAsync not available',
      { key }
    );
  }
  try {
    fn(key, state as Parameters<typeof fn>[1]);
  } catch (error) {
    throw buildStateIntegrationFailure('sticky_session_store.save_async.invoke', error, { key });
  }
}

export function saveRoutingInstructionStateSync(key: string, state: unknown | null): void {
  const stickySessionStoreModule = requireCoreDist<{
    saveRoutingInstructionStateSync?: (key: string, state: unknown | null) => void;
  }>('router/virtual-router/sticky-session-store');
  const fn = stickySessionStoreModule.saveRoutingInstructionStateSync;
  if (typeof fn !== 'function') {
    throw buildStateIntegrationFailure(
      'sticky_session_store.save_sync.api_unavailable',
      'saveRoutingInstructionStateSync not available',
      { key }
    );
  }
  try {
    fn(key, state as Parameters<typeof fn>[1]);
  } catch (error) {
    throw buildStateIntegrationFailure('sticky_session_store.save_sync.invoke', error, { key });
  }
}

export function syncReasoningStopModeFromRequest(
  adapterContext: unknown,
  fallbackMode?: 'on' | 'off' | 'endless'
): 'on' | 'off' | 'endless' {
  try {
    return syncReasoningStopModeFromRequestFromCore(adapterContext, fallbackMode);
  } catch (error) {
    throw buildStateIntegrationFailure('reasoning_stop_state.sync_mode.invoke', error, { fallbackMode });
  }
}

type SessionIdentifiers = { sessionId?: string; conversationId?: string };

export function extractSessionIdentifiersFromMetadata(meta: Record<string, unknown> | undefined): SessionIdentifiers {
  try {
    return extractSessionIdentifiersFromMetadataWithNative(meta);
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

async function requireClockTaskStoreModule(details?: Record<string, unknown>): Promise<ClockTaskStoreModule> {
  const mod = await getClockTaskStoreModuleSafe();
  if (mod) {
    return mod;
  }
  throw buildStateIntegrationFailure(
    'clock_task_store.load.unavailable',
    'clock task-store module unavailable',
    details
  );
}

async function requireHeartbeatTaskStoreModule(details?: Record<string, unknown>): Promise<HeartbeatTaskStoreModule> {
  const mod = await getHeartbeatTaskStoreModuleSafe();
  if (mod) {
    return mod;
  }
  throw buildStateIntegrationFailure(
    'heartbeat_task_store.load.unavailable',
    'heartbeat task-store module unavailable',
    details
  );
}

function requireModuleFunction<TModule extends object, TArgs extends unknown[], TResult>(
  mod: TModule,
  key: keyof TModule,
  stage: string,
  details?: Record<string, unknown>
): (...args: TArgs) => TResult {
  const fn = (mod as Record<string, unknown>)[String(key)];
  if (typeof fn !== 'function') {
    throw buildStateIntegrationFailure(
      `${stage}.api_unavailable`,
      `${String(key)} not available`,
      details
    );
  }
  return fn as (...args: TArgs) => TResult;
}

export async function resolveClockConfigSnapshot(input: unknown): Promise<unknown | null> {
  const mod = await requireClockTaskStoreModule();
  const fn = requireModuleFunction<ClockTaskStoreModule, [unknown], unknown | null>(
    mod,
    'resolveClockConfig',
    'clock_task_store.resolve_config'
  );
  try {
    return fn(input) ?? null;
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.resolve_config.invoke', error);
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
  const mod = await requireClockTaskStoreModule();
  const fn = requireModuleFunction<ClockTaskStoreModule, [typeof hooks | undefined], void | Promise<void>>(
    mod,
    'setClockRuntimeHooks',
    'clock_task_store.set_runtime_hooks'
  );
  try {
    await fn(hooks);
    return true;
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.set_runtime_hooks.invoke', error);
  }
}

export async function startClockDaemonIfNeededSnapshot(config: unknown): Promise<boolean> {
  const mod = await requireClockTaskStoreModule();
  const fn = requireModuleFunction<ClockTaskStoreModule, [unknown], void | Promise<void>>(
    mod,
    'startClockDaemonIfNeeded',
    'clock_task_store.start_daemon'
  );
  try {
    await fn(config);
    return true;
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.start_daemon.invoke', error);
  }
}

export async function reserveClockDueTasks(args: {
  reservationId: string;
  sessionId: string;
  config: unknown;
  requestId?: string;
}): Promise<{ reservation: unknown | null; injectText?: string }> {
  const mod = await requireClockTaskStoreModule({
    sessionId: args.sessionId,
    requestId: args.requestId
  });
  const fn = requireModuleFunction<
    ClockTaskStoreModule,
    [typeof args],
    Promise<{ reservation: unknown | null; injectText?: string }>
  >(
    mod,
    'reserveDueTasksForRequest',
    'clock_task_store.reserve_due_tasks',
    {
      sessionId: args.sessionId,
      requestId: args.requestId
    }
  );
  try {
    return await fn(args);
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.reserve_due_tasks.invoke', error, {
      sessionId: args.sessionId,
      requestId: args.requestId
    });
  }
}

export async function commitClockDueReservation(args: { reservation: unknown; config: unknown }): Promise<void> {
  const mod = await requireClockTaskStoreModule();
  const fn = requireModuleFunction<ClockTaskStoreModule, [unknown, unknown], Promise<void>>(
    mod,
    'commitClockReservation',
    'clock_task_store.commit_reservation'
  );
  try {
    await fn(args.reservation, args.config);
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.commit_reservation.invoke', error);
  }
}

export async function listClockSessionIdsSnapshot(): Promise<string[]> {
  const mod = await requireClockTaskStoreModule();
  const fn = requireModuleFunction<ClockTaskStoreModule, [], Promise<string[]>>(
    mod,
    'listClockSessionIds',
    'clock_task_store.list_session_ids'
  );
  try {
    const out = await fn();
    return Array.isArray(out)
      ? out.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.list_session_ids.invoke', error);
  }
}

export async function listClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<unknown[]> {
  const mod = await requireClockTaskStoreModule({ sessionId: args.sessionId });
  const fn = requireModuleFunction<ClockTaskStoreModule, [string, unknown], Promise<unknown[]>>(
    mod,
    'listClockTasks',
    'clock_task_store.list_tasks',
    { sessionId: args.sessionId }
  );
  try {
    const out = await fn(args.sessionId, args.config);
    return Array.isArray(out) ? out : [];
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.list_tasks.invoke', error, { sessionId: args.sessionId });
  }
}

export async function scheduleClockTasksSnapshot(args: {
  sessionId: string;
  items: unknown[];
  config: unknown;
}): Promise<unknown[]> {
  const mod = await requireClockTaskStoreModule({ sessionId: args.sessionId });
  const fn = requireModuleFunction<ClockTaskStoreModule, [string, unknown[], unknown], Promise<unknown[]>>(
    mod,
    'scheduleClockTasks',
    'clock_task_store.schedule_tasks',
    { sessionId: args.sessionId }
  );
  try {
    const out = await fn(args.sessionId, Array.isArray(args.items) ? args.items : [], args.config);
    return Array.isArray(out) ? out : [];
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.schedule_tasks.invoke', error, { sessionId: args.sessionId });
  }
}

export async function updateClockTaskSnapshot(args: {
  sessionId: string;
  taskId: string;
  patch: Record<string, unknown>;
  config: unknown;
}): Promise<unknown | null> {
  const mod = await requireClockTaskStoreModule({
    sessionId: args.sessionId,
    taskId: args.taskId
  });
  const fn = requireModuleFunction<
    ClockTaskStoreModule,
    [string, string, Record<string, unknown>, unknown],
    Promise<unknown | null>
  >(
    mod,
    'updateClockTask',
    'clock_task_store.update_task',
    {
      sessionId: args.sessionId,
      taskId: args.taskId
    }
  );
  try {
    return await fn(args.sessionId, args.taskId, args.patch, args.config);
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.update_task.invoke', error, {
      sessionId: args.sessionId,
      taskId: args.taskId
    });
  }
}

export async function cancelClockTaskSnapshot(args: {
  sessionId: string;
  taskId: string;
  config: unknown;
}): Promise<boolean> {
  const mod = await requireClockTaskStoreModule({
    sessionId: args.sessionId,
    taskId: args.taskId
  });
  const fn = requireModuleFunction<ClockTaskStoreModule, [string, string, unknown], Promise<boolean>>(
    mod,
    'cancelClockTask',
    'clock_task_store.cancel_task',
    {
      sessionId: args.sessionId,
      taskId: args.taskId
    }
  );
  try {
    return Boolean(await fn(args.sessionId, args.taskId, args.config));
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.cancel_task.invoke', error, {
      sessionId: args.sessionId,
      taskId: args.taskId
    });
  }
}

export async function clearClockTasksSnapshot(args: { sessionId: string; config: unknown }): Promise<number> {
  const mod = await requireClockTaskStoreModule({ sessionId: args.sessionId });
  const fn = requireModuleFunction<ClockTaskStoreModule, [string, unknown], Promise<number>>(
    mod,
    'clearClockTasks',
    'clock_task_store.clear_tasks',
    { sessionId: args.sessionId }
  );
  try {
    const removed = await fn(args.sessionId, args.config);
    return Number.isFinite(Number(removed)) ? Math.max(0, Math.floor(Number(removed))) : 0;
  } catch (error) {
    throw buildStateIntegrationFailure('clock_task_store.clear_tasks.invoke', error, { sessionId: args.sessionId });
  }
}

export async function resolveHeartbeatConfigSnapshot(input: unknown): Promise<unknown | null> {
  const mod = await requireHeartbeatTaskStoreModule();
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [unknown], unknown | null>(
    mod,
    'resolveHeartbeatConfig',
    'heartbeat_task_store.resolve_config'
  );
  try {
    return fn(input) ?? null;
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.resolve_config.invoke', error);
  }
}

export async function buildHeartbeatInjectTextSnapshot(): Promise<string | null> {
  const mod = await requireHeartbeatTaskStoreModule();
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [], string>(
    mod,
    'buildHeartbeatInjectText',
    'heartbeat_task_store.build_inject_text'
  );
  try {
    const text = fn();
    return typeof text === 'string' && text.trim() ? text : null;
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.build_inject_text.invoke', error);
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
  const mod = await requireHeartbeatTaskStoreModule();
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [typeof hooks | undefined], void | Promise<void>>(
    mod,
    'setHeartbeatRuntimeHooks',
    'heartbeat_task_store.set_runtime_hooks'
  );
  try {
    await fn(hooks);
    return true;
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.set_runtime_hooks.invoke', error);
  }
}

export async function startHeartbeatDaemonIfNeededSnapshot(config: unknown): Promise<boolean> {
  const mod = await requireHeartbeatTaskStoreModule();
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [unknown], void | Promise<void>>(
    mod,
    'startHeartbeatDaemonIfNeeded',
    'heartbeat_task_store.start_daemon'
  );
  try {
    await fn(config);
    return true;
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.start_daemon.invoke', error);
  }
}

export async function loadHeartbeatStateSnapshot(tmuxSessionId: string): Promise<unknown | null> {
  const mod = await requireHeartbeatTaskStoreModule({ tmuxSessionId });
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [string], Promise<unknown>>(
    mod,
    'loadHeartbeatState',
    'heartbeat_task_store.load_state',
    { tmuxSessionId }
  );
  try {
    return await fn(tmuxSessionId);
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.load_state.invoke', error, { tmuxSessionId });
  }
}

export async function listHeartbeatStatesSnapshot(): Promise<unknown[]> {
  const mod = await requireHeartbeatTaskStoreModule();
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [], Promise<unknown[]>>(
    mod,
    'listHeartbeatStates',
    'heartbeat_task_store.list_states'
  );
  try {
    const out = await fn();
    return Array.isArray(out) ? out : [];
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.list_states.invoke', error);
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
  const mod = await requireHeartbeatTaskStoreModule({
    tmuxSessionId: args.tmuxSessionId,
    enabled: args.enabled
  });
  const fn = requireModuleFunction<
    HeartbeatTaskStoreModule,
    [string, boolean, Record<string, unknown> | undefined],
    Promise<unknown>
  >(
    mod,
    'setHeartbeatEnabled',
    'heartbeat_task_store.set_enabled',
    {
      tmuxSessionId: args.tmuxSessionId,
      enabled: args.enabled
    }
  );
  try {
    return await fn(args.tmuxSessionId, args.enabled, {
      ...(typeof args.intervalMs === 'number' ? { intervalMs: args.intervalMs } : {}),
      ...(args.clearIntervalOverride ? { clearIntervalOverride: true } : {}),
      ...(typeof args.source === 'string' && args.source.trim() ? { source: args.source.trim() } : {}),
      ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}),
      ...(args.details && typeof args.details === 'object' ? { details: args.details } : {})
    });
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.set_enabled.invoke', error, {
      tmuxSessionId: args.tmuxSessionId,
      enabled: args.enabled
    });
  }
}

export async function listHeartbeatHistorySnapshot(args: {
  tmuxSessionId: string;
  limit?: number;
}): Promise<unknown[]> {
  const mod = await requireHeartbeatTaskStoreModule({ tmuxSessionId: args.tmuxSessionId });
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [typeof args], Promise<unknown[]>>(
    mod,
    'listHeartbeatHistory',
    'heartbeat_task_store.list_history',
    { tmuxSessionId: args.tmuxSessionId }
  );
  try {
    const out = await fn(args);
    return Array.isArray(out) ? out : [];
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.list_history.invoke', error, {
      tmuxSessionId: args.tmuxSessionId
    });
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
  const mod = await requireHeartbeatTaskStoreModule({ tmuxSessionId: input.tmuxSessionId });
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [typeof input], Promise<boolean>>(
    mod,
    'appendHeartbeatHistoryEvent',
    'heartbeat_task_store.append_history_event',
    { tmuxSessionId: input.tmuxSessionId }
  );
  try {
    return Boolean(await fn(input));
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.append_history_event.invoke', error, {
      tmuxSessionId: input.tmuxSessionId,
      source: input.source,
      action: input.action
    });
  }
}

export async function runHeartbeatDaemonTickSnapshot(): Promise<boolean> {
  const mod = await requireHeartbeatTaskStoreModule();
  const fn = requireModuleFunction<HeartbeatTaskStoreModule, [], Promise<void>>(
    mod,
    'runHeartbeatDaemonTickForTests',
    'heartbeat_task_store.run_tick'
  );
  try {
    await fn();
    return true;
  } catch (error) {
    throw buildStateIntegrationFailure('heartbeat_task_store.run_tick.invoke', error);
  }
}
