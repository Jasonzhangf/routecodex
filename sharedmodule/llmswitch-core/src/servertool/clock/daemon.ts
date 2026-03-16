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

  const tickOnce = async () => {
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
          const raw = await readJsonFile(filePath);
          const sessionId = resolveStateSessionId(
            raw,
            entry.name.slice(0, -".json".length),
          );
          const state = coerceState(raw, sessionId);

          const tmuxSessionId = resolveStateTmuxSessionId(raw, sessionId);

          const isAlive = runtimeHooks?.isTmuxSessionAlive;
          if (isAlive && tmuxSessionId) {
            const alive = await Promise.resolve(isAlive(tmuxSessionId));
            if (!alive) {
              await fs.rm(filePath, { force: true });
              continue;
            }
          }

          const dueTasks = selectDueUndeliveredTasks(
            state.tasks,
            effective,
            at,
          );
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
              }
            } catch {
              // best-effort dispatch
            }
          }

          const cleaned = cleanExpiredTasks(state.tasks, effective, at);
          if (!cleaned.length) {
            await fs.rm(filePath, { force: true });
            continue;
          }
          if (cleaned.length !== state.tasks.length) {
            const next: ClockSessionState = {
              ...state,
              tasks: cleaned,
              updatedAtMs: at,
            };
            await writeJsonFileAtomic(filePath, next);
          }
        } catch {
          // best-effort: ignore per-file errors
        }
      }
    } catch {
      // best-effort: ignore global scan errors
    }
  };

  // Startup scan (best-effort), but await it so callers do not immediately
  // race a second tick against the same due-task snapshot.
  await tickOnce();

  if (config.tickMs > 0) {
    daemonTimer = setInterval(() => {
      void tickOnce();
    }, config.tickMs);
    daemonTimer.unref?.();
  }
}

export async function stopClockDaemonForTests(): Promise<void> {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = undefined;
  }
  daemonStarted = false;
  daemonConfig = undefined;
}

export async function runClockDaemonTickForTests(): Promise<void> {
  const effective = daemonConfig;
  if (!effective) return;
  const base = readSessionDirEnv();
  if (!base) return;
  const dir = resolveClockDir(base);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const at = nowMs();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const raw = await readJsonFile(filePath);
    const sessionId = resolveStateSessionId(
      raw,
      entry.name.slice(0, -".json".length),
    );
    const state = coerceState(raw, sessionId);

    const tmuxSessionId = resolveStateTmuxSessionId(raw, sessionId);

    const isAlive = runtimeHooks?.isTmuxSessionAlive;
    if (isAlive && tmuxSessionId) {
      const alive = await Promise.resolve(isAlive(tmuxSessionId));
      if (!alive) {
        await fs.rm(filePath, { force: true });
        continue;
      }
    }

    const dueTasks = selectDueUndeliveredTasks(state.tasks, effective, at);
    const deliveryBatch = selectClockReminderDeliveryBatch(dueTasks);
    if (deliveryBatch.length > 0 && runtimeHooks?.dispatchDueTask && tmuxSessionId) {
      const firstTask = deliveryBatch[0];
      const injectText = formatClockReminderBatchText(deliveryBatch);
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
      }
    }
  }
}
