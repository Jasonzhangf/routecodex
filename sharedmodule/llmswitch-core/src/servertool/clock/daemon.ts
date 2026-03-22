import fs from "node:fs/promises";
import path from "node:path";

import type {
  ClockConfigSnapshot,
  ClockSessionState,
} from "./types.js";
import { readSessionDirEnv, resolveClockDir } from "./paths.js";
import { cleanExpiredTasks, coerceState, nowMs } from "./state.js";
import { readJsonFile, writeJsonFileAtomic } from "./io.js";
import { startClockNtpSyncIfNeeded } from "./ntp.js";
import {
  selectDueUndeliveredTasks,
  selectClockReminderDeliveryBatch,
  commitClockReservation,
  formatClockReminderBatchText
} from "./tasks.js";

let daemonStarted = false;
let daemonTimer: NodeJS.Timeout | undefined;
let daemonConfig: ClockConfigSnapshot | undefined;
type ClockDaemonTickPhase = "startup" | "runtime" | "shutdown";

type ClockRuntimeHooks = {
  isTmuxSessionAlive?: (tmuxSessionId: string) => boolean | Promise<boolean>;
  dispatchDueTask?: (request: {
    sessionId: string;
    tmuxSessionId: string;
    task: unknown;
    injectText: string;
  }) =>
    | Promise<{ ok: boolean; cleanupSession?: boolean; reason?: string } | null>
    | { ok: boolean; cleanupSession?: boolean; reason?: string }
    | null;
};

let runtimeHooks: ClockRuntimeHooks | undefined;

export function setClockRuntimeHooks(hooks?: ClockRuntimeHooks): void {
  runtimeHooks = hooks;
}

export function resetClockRuntimeHooksForTests(): void {
  runtimeHooks = undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveStateSessionId(raw: unknown, fallbackFileSessionId: string): string {
  const rawSessionId =
    raw && typeof raw === "object"
      ? readString((raw as { sessionId?: unknown }).sessionId)
      : undefined;
  return rawSessionId || fallbackFileSessionId;
}

function resolveStateTmuxSessionId(raw: unknown, sessionId: string): string | undefined {
  const rawTmuxSessionId =
    raw && typeof raw === "object"
      ? readString((raw as { tmuxSessionId?: unknown }).tmuxSessionId)
      : undefined;
  if (rawTmuxSessionId) {
    return rawTmuxSessionId;
  }
  if (sessionId.startsWith("tmux:")) {
    const tmuxSessionId = sessionId.slice("tmux:".length).trim();
    return tmuxSessionId || undefined;
  }
  return undefined;
}

function shouldDeleteClockStateFile(phase: ClockDaemonTickPhase): boolean {
  return phase === "startup" || phase === "shutdown";
}

function shouldDisableClockStateForDispatchFailure(reasonRaw: unknown): boolean {
  const reason = readString(reasonRaw)?.toLowerCase();
  if (!reason) {
    return false;
  }
  return (
    reason === "tmux_session_required" ||
    reason === "tmux_session_not_found" ||
    reason.startsWith("tmux_send_failed")
  );
}

function applyClockDisableState(state: ClockSessionState, at: number, reason: string): ClockSessionState {
  const normalizedReason = readString(reason) || "disabled";
  return {
    ...state,
    disabled: true,
    disabledReason: normalizedReason,
    ...(typeof state.disabledAtMs === "number" && Number.isFinite(state.disabledAtMs)
      ? {}
      : { disabledAtMs: at }),
    updatedAtMs: at,
  };
}

function clearClockDisableState(state: ClockSessionState, at: number): ClockSessionState {
  return {
    ...state,
    disabled: false,
    disabledReason: undefined,
    disabledAtMs: undefined,
    updatedAtMs: at,
  };
}

async function persistClockStateForPhase(
  filePath: string,
  state: ClockSessionState,
  phase: ClockDaemonTickPhase,
): Promise<void> {
  if (state.tasks.length < 1 && shouldDeleteClockStateFile(phase)) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeJsonFileAtomic(filePath, state);
}

async function processClockStateFile(args: {
  filePath: string;
  entryName: string;
  effective: ClockConfigSnapshot;
  at: number;
  phase: ClockDaemonTickPhase;
}): Promise<void> {
  const { filePath, entryName, effective, at, phase } = args;
  const raw = await readJsonFile(filePath);
  const sessionId = resolveStateSessionId(raw, entryName.slice(0, -".json".length));
  let state = coerceState(raw, sessionId);
  const tmuxSessionId = resolveStateTmuxSessionId(raw, sessionId);
  const isAlive = runtimeHooks?.isTmuxSessionAlive;
  if (isAlive && tmuxSessionId) {
    const alive = await Promise.resolve(isAlive(tmuxSessionId));
    if (!alive) {
      if (shouldDeleteClockStateFile(phase)) {
        await fs.rm(filePath, { force: true });
        return;
      }
      const disabledState = applyClockDisableState(state, at, "tmux_session_not_found");
      await writeJsonFileAtomic(filePath, disabledState);
      return;
    }
    if (state.disabled === true) {
      state = clearClockDisableState(state, at);
      await writeJsonFileAtomic(filePath, state);
    }
  } else if (state.disabled === true) {
    return;
  }

  const dueTasks = selectDueUndeliveredTasks(state.tasks, effective, at);
  const deliveryBatch = selectClockReminderDeliveryBatch(dueTasks);
  if (
    deliveryBatch.length > 0 &&
    runtimeHooks?.dispatchDueTask &&
    tmuxSessionId
  ) {
    const firstTask = deliveryBatch[0];
    const injectText = formatClockReminderBatchText(deliveryBatch);
    try {
      const result = await Promise.resolve(
        runtimeHooks.dispatchDueTask({
          sessionId,
          tmuxSessionId,
          task: firstTask,
          injectText,
        }),
      );
      if (result?.ok) {
        const reservation = {
          reservationId: `daemon:${firstTask.taskId}:${at}`,
          sessionId,
          taskIds: deliveryBatch.map((task) => task.taskId),
          reservedAtMs: at,
        };
        await commitClockReservation(reservation, effective);
      } else {
        const failureReason = readString(result?.reason) || "dispatch_failed";
        if (
          result?.cleanupSession === true ||
          shouldDisableClockStateForDispatchFailure(failureReason)
        ) {
          if (shouldDeleteClockStateFile(phase)) {
            await fs.rm(filePath, { force: true });
          } else {
            const disabledState = applyClockDisableState(state, at, failureReason);
            await writeJsonFileAtomic(filePath, disabledState);
          }
          return;
        }
      }
    } catch {
      // best-effort dispatch
    }
  }

  const cleaned = cleanExpiredTasks(state.tasks, effective, at);
  if (cleaned.length !== state.tasks.length || cleaned.length < 1) {
    const next: ClockSessionState = {
      ...state,
      tasks: cleaned,
      updatedAtMs: at,
    };
    await persistClockStateForPhase(filePath, next, phase);
  }
}

async function tickClockDaemon(phase: ClockDaemonTickPhase): Promise<void> {
  const effective = daemonConfig;
  if (!effective) return;
  const base = readSessionDirEnv();
  if (!base) return;
  const dir = resolveClockDir(base);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const at = nowMs();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      const filePath = path.join(dir, entry.name);
      try {
        await processClockStateFile({
          filePath,
          entryName: entry.name,
          effective,
          at,
          phase,
        });
      } catch {
        // best-effort: ignore per-file errors
      }
    }
  } catch {
    // best-effort: ignore global scan errors
  }
}

export async function startClockDaemonIfNeeded(
  config: ClockConfigSnapshot,
): Promise<void> {
  daemonConfig = config;
  if (daemonStarted) {
    return;
  }
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  daemonStarted = true;
  // Best-effort NTP sync (do not block daemon startup).
  void startClockNtpSyncIfNeeded(config);

  // Startup scan (best-effort), but await it so callers do not immediately
  // race a second tick against the same due-task snapshot.
  await tickClockDaemon("startup");

  if (config.tickMs > 0) {
    daemonTimer = setInterval(() => {
      void tickClockDaemon("runtime");
    }, config.tickMs);
    daemonTimer.unref?.();
  }
}

export async function stopClockDaemonForTests(): Promise<void> {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = undefined;
  }
  await tickClockDaemon("shutdown");
  daemonStarted = false;
  daemonConfig = undefined;
}

export async function runClockDaemonTickForTests(): Promise<void> {
  await tickClockDaemon("runtime");
}
