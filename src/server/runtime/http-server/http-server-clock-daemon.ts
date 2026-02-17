import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveClockConfigSnapshot,
  reserveClockDueTasks,
  commitClockDueReservation,
  clearClockTasksSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { getClockClientRegistry } from './clock-client-registry.js';
import { toExactMatchClockConfig } from './clock-daemon-inject-config.js';
import { shouldClearClockTasksForInjectSkip, shouldLogClockDaemonInjectSkip } from './clock-daemon-log-throttle.js';
import { isTmuxSessionAlive, killManagedTmuxSession } from './tmux-session-probe.js';
import { terminateManagedClientProcess } from './managed-process-probe.js';

const CLOCK_DAEMON_SESSION_PREFIX = 'clockd.';

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

    const sessionDir = String(process.env.ROUTECODEX_SESSION_DIR || '').trim();
    const clockDir = sessionDir ? path.join(sessionDir, 'clock') : '';
    const entries = clockDir ? await fs.readdir(clockDir, { withFileTypes: true }).catch(() => [] as Dirent[]) : ([] as Dirent[]);

    const registry = getClockClientRegistry();
    const now = Date.now();
    const cleanupRequestId = `clock_cleanup_${now}_${Math.random().toString(16).slice(2, 8)}`;
    const allowManagedTermination = isClockManagedTerminationEnabled();

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
    if (hasCleanupActions && Date.now() - server.lastClockDaemonCleanupAtMs > 2000) {
      server.lastClockDaemonCleanupAtMs = Date.now();
      console.log('[RouteCodexHttpServer] clock daemon cleanup audit:', {
        requestId: cleanupRequestId,
        managedTerminationEnabled: allowManagedTermination,
        staleHeartbeat: {
          reason: 'heartbeat_timeout',
          staleAfterMs: staleCleanup.staleAfterMs,
          removedDaemonIds: staleCleanup.removedDaemonIds,
          removedTmuxSessionIds: staleCleanup.removedTmuxSessionIds,
          removedConversationSessionIds: staleCleanup.removedConversationSessionIds,
          killedTmuxSessionIds: staleCleanup.killedTmuxSessionIds,
          failedKillTmuxSessionIds: staleCleanup.failedKillTmuxSessionIds,
          skippedKillTmuxSessionIds: staleCleanup.skippedKillTmuxSessionIds,
          killedManagedClientPids: staleCleanup.killedManagedClientPids,
          failedKillManagedClientPids: staleCleanup.failedKillManagedClientPids,
          skippedKillManagedClientPids: staleCleanup.skippedKillManagedClientPids
        },
        deadTmux: {
          reason: 'tmux_not_alive',
          removedDaemonIds: deadTmuxCleanup.removedDaemonIds,
          removedTmuxSessionIds: deadTmuxCleanup.removedTmuxSessionIds,
          removedConversationSessionIds: deadTmuxCleanup.removedConversationSessionIds,
          killedTmuxSessionIds: deadTmuxCleanup.killedTmuxSessionIds,
          failedKillTmuxSessionIds: deadTmuxCleanup.failedKillTmuxSessionIds,
          skippedKillTmuxSessionIds: deadTmuxCleanup.skippedKillTmuxSessionIds,
          killedManagedClientPids: deadTmuxCleanup.killedManagedClientPids,
          failedKillManagedClientPids: deadTmuxCleanup.failedKillManagedClientPids,
          skippedKillManagedClientPids: deadTmuxCleanup.skippedKillManagedClientPids
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
      const bind = registry.bindConversationSession({
        conversationSessionId: sessionId,
        ...(daemonId ? { daemonId } : {})
      });

      const text = [
        '[Clock Reminder]: scheduled tasks are due.',
        reserved.injectText.trim(),
        'Only call tools that are actually available in your current runtime.'
      ].join('\n');

      const injected = await registry.inject({
        sessionId,
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
