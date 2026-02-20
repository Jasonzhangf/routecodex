import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveClockConfigSnapshot,
  reserveClockDueTasks,
  commitClockDueReservation,
  clearClockTasksSnapshot,
  listClockTasksSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { getClockClientRegistry } from './clock-client-registry.js';
import { toExactMatchClockConfig } from './clock-daemon-inject-config.js';
import {
  shouldClearClockTasksForInjectSkip,
  shouldLogClockDaemonCleanupAudit,
  shouldLogClockDaemonInjectSkip
} from './clock-daemon-log-throttle.js';
import { isTmuxSessionAlive, killManagedTmuxSession } from './tmux-session-probe.js';
import { terminateManagedClientProcess } from './managed-process-probe.js';

const CLOCK_DAEMON_SESSION_PREFIX = 'clockd.';
const CLOCK_CLEANUP_AUDIT_SAMPLE_LIMIT = 3;

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

function shouldEnableClockCleanupAuditLog(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_CLOCK_DAEMON_CLEANUP_AUDIT_LOG ?? process.env.RCC_CLOCK_DAEMON_CLEANUP_AUDIT_LOG,
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
    sample: normalized.slice(0, CLOCK_CLEANUP_AUDIT_SAMPLE_LIMIT)
  };
}

function summarizeNumberList(values: number[]): { count: number; sample: number[] } {
  if (!Array.isArray(values) || values.length < 1) {
    return { count: 0, sample: [] };
  }
  const normalized = values.filter((entry) => Number.isFinite(entry)).map((entry) => Math.floor(entry));
  return {
    count: normalized.length,
    sample: normalized.slice(0, CLOCK_CLEANUP_AUDIT_SAMPLE_LIMIT)
  };
}

function isClockManagedTerminationEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_CLOCK_REAPER_TERMINATE_MANAGED ?? process.env.RCC_CLOCK_REAPER_TERMINATE_MANAGED,
    false
  );
}

export function shouldEnableClockDaemonInjectLoop(): boolean {
  const raw = String(process.env.ROUTECODEX_CLOCK_DAEMON_INJECT_ENABLE || process.env.RCC_CLOCK_DAEMON_INJECT_ENABLE || '')
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

function extractClockDaemonIdFromSessionScope(sessionId: string): string | undefined {
  const normalized = String(sessionId || '').trim();
  if (!normalized.startsWith(CLOCK_DAEMON_SESSION_PREFIX)) {
    return undefined;
  }
  const daemonId = normalized.slice(CLOCK_DAEMON_SESSION_PREFIX.length).trim();
  return daemonId || undefined;
}

export function resolveRawClockConfig(server: any): unknown {
  const user = server.userConfig && typeof server.userConfig === 'object' ? (server.userConfig as Record<string, unknown>) : {};
  const vr = user.virtualrouter && typeof user.virtualrouter === 'object' ? (user.virtualrouter as Record<string, unknown>) : null;
  if (vr && Object.prototype.hasOwnProperty.call(vr, 'clock')) {
    return vr.clock;
  }
  if (Object.prototype.hasOwnProperty.call(user, 'clock')) {
    return (user as Record<string, unknown>).clock;
  }

  const artCfg =
    server.currentRouterArtifacts &&
    server.currentRouterArtifacts.config &&
    typeof server.currentRouterArtifacts.config === 'object'
      ? (server.currentRouterArtifacts.config as Record<string, unknown>)
      : null;
  if (artCfg && Object.prototype.hasOwnProperty.call(artCfg, 'clock')) {
    return artCfg.clock;
  }
  return undefined;
}

export function stopClockDaemonInjectLoop(server: any): void {
  if (server.clockDaemonInjectTimer) {
    clearInterval(server.clockDaemonInjectTimer);
    server.clockDaemonInjectTimer = null;
  }
}

export function startClockDaemonInjectLoop(server: any): void {
  stopClockDaemonInjectLoop(server);
  if (!shouldEnableClockDaemonInjectLoop()) {
    return;
  }

  const rawTick = String(process.env.ROUTECODEX_CLOCK_DAEMON_INJECT_TICK_MS || process.env.RCC_CLOCK_DAEMON_INJECT_TICK_MS || '').trim();
  const parsedTick = rawTick ? Number.parseInt(rawTick, 10) : NaN;
  const tickMs = Number.isFinite(parsedTick) && parsedTick >= 200 ? Math.floor(parsedTick) : 1500;

  server.clockDaemonInjectTimer = setInterval(() => {
    void tickClockDaemonInjectLoop(server);
  }, tickMs);
  server.clockDaemonInjectTimer.unref?.();

  void tickClockDaemonInjectLoop(server);
}

export async function tickClockDaemonInjectLoop(server: any): Promise<void> {
  if (server.clockDaemonInjectTickInFlight) {
    return;
  }
  server.clockDaemonInjectTickInFlight = true;
  try {
    const rawClockConfig = resolveRawClockConfig(server);
    const resolvedClockConfig = await resolveClockConfigSnapshot(rawClockConfig);
    if (!resolvedClockConfig) {
      return;
    }
    const clockConfig = toExactMatchClockConfig(resolvedClockConfig);

    const sessionDir = readSessionDirFromEnv(process.env.ROUTECODEX_SESSION_DIR) || '';
    const clockDir = sessionDir ? path.join(sessionDir, 'clock') : '';
    const entries = clockDir ? await fs.readdir(clockDir, { withFileTypes: true }).catch(() => [] as Dirent[]) : ([] as Dirent[]);

    const registry = getClockClientRegistry();
    const now = Date.now();
    const cleanupRequestId = `clock_cleanup_${now}_${Math.random().toString(16).slice(2, 8)}`;
    const allowManagedTermination = isClockManagedTerminationEnabled();
    const enableCleanupAuditLog = shouldEnableClockCleanupAuditLog();

    const deadTmuxCleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive,
      ...(allowManagedTermination
        ? {
            terminateManagedTmuxSession: (tmuxSessionId: string) => killManagedTmuxSession(tmuxSessionId),
            terminateManagedClientProcess: (processInfo: {
              daemonId: string;
              pid: number;
              commandHint?: string;
              clientType?: string;
            }) => terminateManagedClientProcess(processInfo)
          }
        : {})
    });
    const staleCleanup = registry.cleanupStaleHeartbeats({
      nowMs: now,
      ...(allowManagedTermination
        ? {
            terminateManagedTmuxSession: (tmuxSessionId: string) => killManagedTmuxSession(tmuxSessionId),
            terminateManagedClientProcess: (processInfo: {
              daemonId: string;
              pid: number;
              commandHint?: string;
              clientType?: string;
            }) => terminateManagedClientProcess(processInfo)
          }
        : {})
    });

    const removedConversationSessionIds = Array.from(
      new Set<string>([...staleCleanup.removedConversationSessionIds, ...deadTmuxCleanup.removedConversationSessionIds])
    );
    const removedTmuxSessionIds = Array.from(
      new Set<string>([...staleCleanup.removedTmuxSessionIds, ...deadTmuxCleanup.removedTmuxSessionIds])
    );
    const cleanupClockSessionIds = Array.from(new Set<string>([...removedConversationSessionIds, ...removedTmuxSessionIds]));

    if (cleanupClockSessionIds.length > 0) {
      for (const cleanupSessionId of cleanupClockSessionIds) {
        await clearClockTasksSnapshot({
          sessionId: cleanupSessionId,
          config: clockConfig
        });
      }
    }

    const hasCleanupActions = staleCleanup.removedDaemonIds.length > 0 || deadTmuxCleanup.removedDaemonIds.length > 0;
    if (
      hasCleanupActions
      && enableCleanupAuditLog
      && Date.now() - server.lastClockDaemonCleanupAtMs > 2000
      && shouldLogClockDaemonCleanupAudit({
        cache: server.clockDaemonCleanupLogByKey,
        input: {
          managedTerminationEnabled: allowManagedTermination,
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
      server.lastClockDaemonCleanupAtMs = Date.now();
      console.log('[RouteCodexHttpServer] clock daemon cleanup audit:', {
        requestId: cleanupRequestId,
        managedTerminationEnabled: allowManagedTermination,
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

      const reservationId = 'clockd_inject_' + now + '_' + Math.random().toString(16).slice(2, 8);
      const reserved = await reserveClockDueTasks({
        reservationId,
        sessionId,
        config: clockConfig,
        requestId: reservationId
      });

      if (!reserved || !reserved.reservation || typeof reserved.injectText !== 'string' || !reserved.injectText.trim()) {
        continue;
      }

      const daemonId = extractClockDaemonIdFromSessionScope(sessionId);
      const persistedTmuxSessionId = registry.resolveBoundTmuxSession(sessionId);
      const daemonWorkdirHint = daemonId ? readString(registry.findByDaemonId(daemonId)?.workdir) : undefined;
      const boundWorkdirHint = registry.resolveBoundWorkdir(sessionId);
      let taskWorkdirHint: string | undefined;
      const reservationTaskIds = extractReservationTaskIds(reserved.reservation);
      if (reservationTaskIds.size > 0) {
        const tasks = await listClockTasksSnapshot({ sessionId, config: clockConfig });
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
        '[Clock Reminder]: scheduled tasks are due.',
        reserved.injectText.trim(),
        'Only call tools that are actually available in your current runtime.'
      ].join('\n');

      const injected = await registry.inject({
        sessionId,
        ...(tmuxSessionId ? { tmuxSessionId } : {}),
        ...(workdirHint ? { workdir: workdirHint } : {}),
        text,
        requestId: reservationId,
        source: 'clock.daemon.inject'
      });

      if (!injected.ok) {
        const shouldClearOrphanTasks = shouldClearClockTasksForInjectSkip({
          sessionId,
          injectReason: injected.reason,
          bindReason: bind.reason
        });
        let clearedClockTasks = 0;
        if (shouldClearOrphanTasks) {
          registry.unbindConversationSession(sessionId);
          clearedClockTasks = await clearClockTasksSnapshot({ sessionId, config: clockConfig });
        }
        if (
          shouldLogClockDaemonInjectSkip({
            cache: server.clockDaemonInjectSkipLogByKey,
            input: {
              sessionId,
              injectReason: injected.reason,
              bindReason: bind.reason
            }
          })
        ) {
          console.warn('[RouteCodexHttpServer] clock daemon inject skipped:', {
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
        config: clockConfig
      });
    }
  } catch (error) {
    const now = Date.now();
    if (now - server.lastClockDaemonInjectErrorAtMs > 5000) {
      server.lastClockDaemonInjectErrorAtMs = now;
      console.warn('[RouteCodexHttpServer] clock daemon inject loop tick failed:', error);
    }
  } finally {
    server.clockDaemonInjectTickInFlight = false;
  }
}
