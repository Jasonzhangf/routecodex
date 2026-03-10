import {
  resolveClockConfigSnapshot,
  startClockDaemonIfNeededSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { toExactMatchSessionConfig } from './session-daemon-inject-config.js';

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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

export function resolveRawSessionConfig(server: any): unknown {
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
    await startClockDaemonIfNeededSnapshot(sessionConfig);
  } catch (error) {
    const now = Date.now();
    if (now - server.lastSessionDaemonInjectErrorAtMs > 5000) {
      server.lastSessionDaemonInjectErrorAtMs = now;
      console.warn('[RouteCodexHttpServer] session daemon bootstrap failed:', error);
    }
  } finally {
    server.sessionDaemonInjectTickInFlight = false;
  }
}
