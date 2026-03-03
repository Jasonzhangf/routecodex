import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveClockConfigSnapshot,
  reserveClockDueTasks,
  commitClockDueReservation,
  clearClockTasksSnapshot,
  listClockTasksSnapshot,
  saveRoutingInstructionStateSync
} from '../../../modules/llmswitch/bridge.js';
import { getSessionClientRegistry } from './session-client-registry.js';
import { toExactMatchSessionConfig } from './session-daemon-inject-config.js';
import {
  shouldClearSessionTasksForInjectSkip,
  shouldLogSessionDaemonCleanupAudit,
  shouldLogSessionDaemonInjectSkip
} from './session-daemon-log-throttle.js';
import { isTmuxSessionAlive } from './tmux-session-probe.js';

const SESSION_DAEMON_SESSION_PREFIX = 'sessiond.';
const SESSION_CLEANUP_AUDIT_SAMPLE_LIMIT = 3;

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readSessionDirFromEnv(value: unknown): string | undefined {
  const normalized = readString(value);
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null') {
    return undefined;
  }
  return normalized;
}

function extractReservationTaskIds(reservation: unknown): Set<string> {
  if (!reservation || typeof reservation !== 'object') {
    return new Set<string>();
  }
  const rawTaskIds = (reservation as { taskIds?: unknown }).taskIds;
  if (!Array.isArray(rawTaskIds)) {
    return new Set<string>();
  }
  const taskIds = new Set<string>();
  for (const entry of rawTaskIds) {
    const taskId = readString(entry);
    if (taskId) {
      taskIds.add(taskId);
    }
  }
  return taskIds;
}

export function extractWorkdirHintFromReservationTasks(
  tasks: unknown[],
  reservationTaskIds: Set<string>
): string | undefined {
  if (!Array.isArray(tasks) || reservationTaskIds.size < 1) {
    return undefined;
  }

  const candidates = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      continue;
    }
    const taskId = readString((task as { taskId?: unknown }).taskId);
    if (!taskId || !reservationTaskIds.has(taskId)) {
      continue;
    }
    const args = (task as { arguments?: unknown }).arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      continue;
    }
    const workdir =
      readString((args as { workdir?: unknown }).workdir)
      ?? readString((args as { cwd?: unknown }).cwd)
      ?? readString((args as { workingDirectory?: unknown }).workingDirectory);
    if (workdir) {
      candidates.add(workdir);
    }
  }

  if (candidates.size !== 1) {
    return undefined;
  }
  return Array.from(candidates)[0];
}

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function shouldEnableSessionCleanupAuditLog(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_SESSION_DAEMON_CLEANUP_AUDIT_LOG ?? process.env.RCC_SESSION_DAEMON_CLEANUP_AUDIT_LOG,
    false
  );
}

function summarizeStringList(values: string[]): { count: number; sample: string[] } {
  if (!Array.isArray(values) || values.length < 1) {
    return { count: 0, sample: [] };
  }
  const normalized = values
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return {
    count: normalized.length,
    sample: normalized.slice(0, SESSION_CLEANUP_AUDIT_SAMPLE_LIMIT)
  };
}

function summarizeNumberList(values: number[]): { count: number; sample: number[] } {
  if (!Array.isArray(values) || values.length < 1) {
    return { count: 0, sample: [] };
  }
  const normalized = values.filter((entry) => Number.isFinite(entry)).map((entry) => Math.floor(entry));
  return {
    count: normalized.length,
    sample: normalized.slice(0, SESSION_CLEANUP_AUDIT_SAMPLE_LIMIT)
  };
}

function clearScopedRoutingStateByScope(scope: string | undefined): void {
  const normalized = readString(scope);
  if (!normalized) {
    return;
  }
  try {
    saveRoutingInstructionStateSync(normalized, null);
  } catch {
    // best-effort only
  }
}

function clearScopedRoutingStateForSessionCleanup(args: {
  removedDaemonIds: string[];
  removedTmuxSessionIds: string[];
  extraScopes?: string[];
}): void {
  for (const daemonId of args.removedDaemonIds) {
    clearScopedRoutingStateByScope(`sessiond.${daemonId}`);
  }
  for (const tmuxSessionId of args.removedTmuxSessionIds) {
    clearScopedRoutingStateByScope(`tmux:${tmuxSessionId}`);
  }
  for (const scope of args.extraScopes || []) {
    clearScopedRoutingStateByScope(scope);
  }
}

export function shouldEnableSessionDaemonInjectLoop(): boolean {
  const raw = String(process.env.ROUTECODEX_SESSION_DAEMON_INJECT_ENABLE || process.env.RCC_SESSION_DAEMON_INJECT_ENABLE || '')
    .trim()
    .toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
    return false;
  }
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') {
    return true;
  }
  if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    return false;
  }
  return true;
}

function extractSessionDaemonIdFromSessionScope(sessionId: string): string | undefined {
  const normalized = String(sessionId || '').trim();
  if (!normalized.startsWith(SESSION_DAEMON_SESSION_PREFIX)) {
    return undefined;
  }
  const daemonId = normalized.slice(SESSION_DAEMON_SESSION_PREFIX.length).trim();
  return daemonId || undefined;
}

export function resolveRawSessionConfig(server: any): unknown {
  const user = server.userConfig && typeof server.userConfig === 'object' ? (server.userConfig as Record<string, unknown>) : {};
  const vr = user.virtualrouter && typeof user.virtualrouter === 'object' ? (user.virtualrouter as Record<string, unknown>) : null;
  if (vr && Object.prototype.hasOwnProperty.call(vr, 'session')) {
    return vr.session;
  }
  if (Object.prototype.hasOwnProperty.call(user, 'session')) {
    return (user as Record<string, unknown>).session;
  }

  const artCfg =
    server.currentRouterArtifacts &&
    server.currentRouterArtifacts.config &&
    typeof server.currentRouterArtifacts.config === 'object'
      ? (server.currentRouterArtifacts.config as Record<string, unknown>)
      : null;
  if (artCfg && Object.prototype.hasOwnProperty.call(artCfg, 'session')) {
    return artCfg.session;
  }
  return undefined;
}

export function stopSessionDaemonInjectLoop(server: any): void {
  if (server.sessionDaemonInjectTimer) {
    clearInterval(server.sessionDaemonInjectTimer);
    server.sessionDaemonInjectTimer = null;
  }
}

export function startSessionDaemonInjectLoop(server: any): void {
  stopSessionDaemonInjectLoop(server);
  if (!shouldEnableSessionDaemonInjectLoop()) {
    return;
  }
  const rawSessionConfig = resolveRawSessionConfig(server);
  if (!rawSessionConfig) {
    return;
  }

  const rawTick = String(process.env.ROUTECODEX_SESSION_DAEMON_INJECT_TICK_MS || process.env.RCC_SESSION_DAEMON_INJECT_TICK_MS || '').trim();
  const parsedTick = rawTick ? Number.parseInt(rawTick, 10) : NaN;
  const tickMs = Number.isFinite(parsedTick) && parsedTick >= 200 ? Math.floor(parsedTick) : 1500;

  server.sessionDaemonInjectTimer = setInterval(() => {
    void tickSessionDaemonInjectLoop(server);
  }, tickMs);
  server.sessionDaemonInjectTimer.unref?.();

  void tickSessionDaemonInjectLoop(server);
}

export async function tickSessionDaemonInjectLoop(server: any): Promise<void> {
  if (server.sessionDaemonInjectTickInFlight) {
    return;
  }
  server.sessionDaemonInjectTickInFlight = true;
  try {
    const rawSessionConfig = resolveRawSessionConfig(server);
    if (!rawSessionConfig) {
      return;
    }
    const resolvedClockConfig = await resolveClockConfigSnapshot(rawSessionConfig);
    if (!resolvedClockConfig) {
      return;
    }
    const sessionConfig = toExactMatchSessionConfig(resolvedClockConfig);

    const sessionDir = readSessionDirFromEnv(process.env.ROUTECODEX_SESSION_DIR) || '';
    const sessionTaskDir = sessionDir ? path.join(sessionDir, 'clock') : '';
    const entries = sessionTaskDir ? await fs.readdir(sessionTaskDir, { withFileTypes: true }).catch(() => [] as Dirent[]) : ([] as Dirent[]);

    const registry = getSessionClientRegistry();
    const now = Date.now();
    const cleanupRequestId = `session_cleanup_${now}_${Math.random().toString(16).slice(2, 8)}`;
    const enableCleanupAuditLog = shouldEnableSessionCleanupAuditLog();

    const deadTmuxCleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive
    });
    const staleCleanup = registry.cleanupStaleHeartbeats({
      nowMs: now
    });

    const removedConversationSessionIds = Array.from(
      new Set<string>([...staleCleanup.removedConversationSessionIds, ...deadTmuxCleanup.removedConversationSessionIds])
    );
    const removedTmuxSessionIds = Array.from(
      new Set<string>([...staleCleanup.removedTmuxSessionIds, ...deadTmuxCleanup.removedTmuxSessionIds])
    );
    const cleanupSessionIds = Array.from(new Set<string>([...removedConversationSessionIds, ...removedTmuxSessionIds]));
    clearScopedRoutingStateForSessionCleanup({
      removedDaemonIds: Array.from(new Set<string>([
        ...staleCleanup.removedDaemonIds,
        ...deadTmuxCleanup.removedDaemonIds
      ])),
      removedTmuxSessionIds,
      extraScopes: removedConversationSessionIds
    });

    if (cleanupSessionIds.length > 0) {
      for (const cleanupSessionId of cleanupSessionIds) {
        await clearClockTasksSnapshot({
          sessionId: cleanupSessionId,
          config: sessionConfig
        });
      }
    }

    const hasCleanupActions = staleCleanup.removedDaemonIds.length > 0 || deadTmuxCleanup.removedDaemonIds.length > 0;
    if (
      hasCleanupActions
      && enableCleanupAuditLog
      && Date.now() - server.lastSessionDaemonCleanupAtMs > 2000
      && shouldLogSessionDaemonCleanupAudit({
        cache: server.sessionDaemonCleanupLogByKey,
        input: {
          managedTerminationEnabled: false,
          staleRemovedDaemonIds: staleCleanup.removedDaemonIds,
          staleRemovedTmuxSessionIds: staleCleanup.removedTmuxSessionIds,
          deadRemovedDaemonIds: deadTmuxCleanup.removedDaemonIds,
          deadRemovedTmuxSessionIds: deadTmuxCleanup.removedTmuxSessionIds,
          failedKillTmuxSessionIds: [...staleCleanup.failedKillTmuxSessionIds, ...deadTmuxCleanup.failedKillTmuxSessionIds],
          failedKillManagedClientPids: [
            ...staleCleanup.failedKillManagedClientPids,
            ...deadTmuxCleanup.failedKillManagedClientPids
          ]
        }
      })
    ) {
      server.lastSessionDaemonCleanupAtMs = Date.now();
      console.log('[RouteCodexHttpServer] session daemon cleanup audit:', {
        requestId: cleanupRequestId,
        managedTerminationEnabled: false,
        staleHeartbeat: {
          reason: 'heartbeat_timeout',
          staleAfterMs: staleCleanup.staleAfterMs,
          removedDaemonIds: summarizeStringList(staleCleanup.removedDaemonIds),
          removedTmuxSessionIds: summarizeStringList(staleCleanup.removedTmuxSessionIds),
          removedConversationSessionIds: summarizeStringList(staleCleanup.removedConversationSessionIds),
          killedTmuxSessionIds: summarizeStringList(staleCleanup.killedTmuxSessionIds),
          failedKillTmuxSessionIds: summarizeStringList(staleCleanup.failedKillTmuxSessionIds),
          skippedKillTmuxSessionIds: summarizeStringList(staleCleanup.skippedKillTmuxSessionIds),
          killedManagedClientPids: summarizeNumberList(staleCleanup.killedManagedClientPids),
          failedKillManagedClientPids: summarizeNumberList(staleCleanup.failedKillManagedClientPids),
          skippedKillManagedClientPids: summarizeNumberList(staleCleanup.skippedKillManagedClientPids)
        },
        deadTmux: {
          reason: 'tmux_not_alive',
          removedDaemonIds: summarizeStringList(deadTmuxCleanup.removedDaemonIds),
          removedTmuxSessionIds: summarizeStringList(deadTmuxCleanup.removedTmuxSessionIds),
          removedConversationSessionIds: summarizeStringList(deadTmuxCleanup.removedConversationSessionIds),
          killedTmuxSessionIds: summarizeStringList(deadTmuxCleanup.killedTmuxSessionIds),
          failedKillTmuxSessionIds: summarizeStringList(deadTmuxCleanup.failedKillTmuxSessionIds),
          skippedKillTmuxSessionIds: summarizeStringList(deadTmuxCleanup.skippedKillTmuxSessionIds),
          killedManagedClientPids: summarizeNumberList(deadTmuxCleanup.killedManagedClientPids),
          failedKillManagedClientPids: summarizeNumberList(deadTmuxCleanup.failedKillManagedClientPids),
          skippedKillManagedClientPids: summarizeNumberList(deadTmuxCleanup.skippedKillManagedClientPids)
        }
      });
    }

    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string') {
        continue;
      }
      if (!entry.name.endsWith('.json')) {
        continue;
      }
      if (typeof entry.isFile === 'function' && !entry.isFile()) {
        continue;
      }
      const sessionId = entry.name.slice(0, -'.json'.length).trim();
      if (!sessionId) {
        continue;
      }

      const reservationId = 'sessiond_inject_' + now + '_' + Math.random().toString(16).slice(2, 8);
      const reserved = await reserveClockDueTasks({
        reservationId,
        sessionId,
        config: sessionConfig,
        requestId: reservationId
      });

      if (!reserved || !reserved.reservation || typeof reserved.injectText !== 'string' || !reserved.injectText.trim()) {
        continue;
      }

      const daemonId = extractSessionDaemonIdFromSessionScope(sessionId);
      const persistedTmuxSessionId = registry.resolveBoundTmuxSession(sessionId);
      const daemonWorkdirHint = daemonId ? readString(registry.findByDaemonId(daemonId)?.workdir) : undefined;
      const boundWorkdirHint = registry.resolveBoundWorkdir(sessionId);
      let taskWorkdirHint: string | undefined;
      const reservationTaskIds = extractReservationTaskIds(reserved.reservation);
      if (reservationTaskIds.size > 0) {
        const tasks = await listClockTasksSnapshot({ sessionId, config: sessionConfig });
        taskWorkdirHint = extractWorkdirHintFromReservationTasks(tasks, reservationTaskIds);
      }
      const workdirHint = daemonWorkdirHint ?? boundWorkdirHint ?? taskWorkdirHint;
      const bind = registry.bindConversationSession({
        conversationSessionId: sessionId,
        ...(persistedTmuxSessionId ? { tmuxSessionId: persistedTmuxSessionId } : {}),
        ...(daemonId ? { daemonId } : {}),
        ...(workdirHint ? { workdir: workdirHint } : {})
      });
      const tmuxSessionId = bind.tmuxSessionId || persistedTmuxSessionId;

      const text = [
        '[Session Reminder]: scheduled tasks are due.',
        reserved.injectText.trim(),
        'Only call tools that are actually available in your current runtime.'
      ].join('\n');

      const injected = await registry.inject({
        sessionId,
        ...(tmuxSessionId ? { tmuxSessionId } : {}),
        ...(workdirHint ? { workdir: workdirHint } : {}),
        text,
        requestId: reservationId,
        source: 'session.daemon.inject'
      });

      if (!injected.ok) {
        const shouldClearOrphanTasks = shouldClearSessionTasksForInjectSkip({
          sessionId,
          injectReason: injected.reason,
          bindReason: bind.reason
        });
        let clearedClockTasks = 0;
        if (shouldClearOrphanTasks) {
          registry.unbindSessionScope(sessionId);
          clearedClockTasks = await clearClockTasksSnapshot({ sessionId, config: sessionConfig });
          clearScopedRoutingStateByScope(sessionId);
          if (tmuxSessionId) {
            clearScopedRoutingStateByScope(`tmux:${tmuxSessionId}`);
          }
        }
        if (
          shouldLogSessionDaemonInjectSkip({
            cache: server.sessionDaemonInjectSkipLogByKey,
            input: {
              sessionId,
              injectReason: injected.reason,
              bindReason: bind.reason
            }
          })
        ) {
          console.warn('[RouteCodexHttpServer] session daemon inject skipped:', {
            sessionId,
            injectReason: injected.reason,
            bindOk: bind.ok,
            bindReason: bind.reason,
            ...(workdirHint ? { workdirHint } : {}),
            ...(shouldClearOrphanTasks ? { clearedClockTasks } : {})
          });
        }
        continue;
      }

      await commitClockDueReservation({
        reservation: reserved.reservation,
        config: sessionConfig
      });
    }
  } catch (error) {
    const now = Date.now();
    if (now - server.lastSessionDaemonInjectErrorAtMs > 5000) {
      server.lastSessionDaemonInjectErrorAtMs = now;
      console.warn('[RouteCodexHttpServer] session daemon inject loop tick failed:', error);
    }
  } finally {
    server.sessionDaemonInjectTickInFlight = false;
  }
}
