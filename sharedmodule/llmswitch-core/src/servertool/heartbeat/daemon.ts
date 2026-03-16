import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, readSessionDirEnv } from "../clock/paths.js";
import { readJsonFile } from "../clock/io.js";
import { nowMs } from "../clock/state.js";
import { normalizeHeartbeatConfig } from "./config.js";
import { resolveHeartbeatDir } from "./paths.js";
import {
  coerceHeartbeatState,
  removeHeartbeatState,
  saveHeartbeatState,
} from "./session-store.js";
import type {
  HeartbeatConfigSnapshot,
  HeartbeatDispatchResult,
  HeartbeatState,
} from "./types.js";

let daemonStarted = false;
let daemonTimer: NodeJS.Timeout | undefined;
let daemonConfig: HeartbeatConfigSnapshot | undefined;

type HeartbeatRuntimeHooks = {
  isTmuxSessionAlive?: (tmuxSessionId: string) => boolean | Promise<boolean>;
  dispatchHeartbeat?: (request: {
    tmuxSessionId: string;
    state: HeartbeatState;
    injectText: string;
  }) => HeartbeatDispatchResult | Promise<HeartbeatDispatchResult>;
};

let runtimeHooks: HeartbeatRuntimeHooks | undefined;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function buildHeartbeatInjectText(): string {
  return [
    "[Heartbeat]",
    "请读取当前目录的 HEARTBEAT.md 进行任务巡检。",
    "先检查上一次交付是否完整、是否还需要继续修复。",
    "完成后更新 DELIVERY.md，然后调用 review。",
    "不要只做汇报；如果仍有未完成项，请直接继续执行。",
  ].join("\n");
}

function shouldTriggerHeartbeat(
  state: HeartbeatState,
  config: HeartbeatConfigSnapshot,
  at: number,
): boolean {
  if (!state.enabled) {
    return false;
  }
  if (
    typeof state.lastTriggeredAtMs !== "number" ||
    !Number.isFinite(state.lastTriggeredAtMs)
  ) {
    return true;
  }
  return at - state.lastTriggeredAtMs >= config.tickMs;
}

async function processHeartbeatStateFile(
  filePath: string,
  at: number,
): Promise<void> {
  const raw = await readJsonFile(filePath);
  const fallbackTmuxSessionId = path.basename(filePath).replace(/\.json$/i, "");
  const state = coerceHeartbeatState(raw, fallbackTmuxSessionId);
  const tmuxSessionId = readString(state.tmuxSessionId);
  if (!tmuxSessionId) {
    await removeHeartbeatState(fallbackTmuxSessionId);
    return;
  }

  const isAlive = runtimeHooks?.isTmuxSessionAlive;
  if (isAlive) {
    const alive = await Promise.resolve(isAlive(tmuxSessionId));
    if (!alive) {
      await removeHeartbeatState(tmuxSessionId);
      return;
    }
  }

  const effective = daemonConfig || normalizeHeartbeatConfig(undefined);
  if (!shouldTriggerHeartbeat(state, effective, at)) {
    return;
  }

  const dispatch = runtimeHooks?.dispatchHeartbeat;
  if (!dispatch) {
    return;
  }
  const result = await Promise.resolve(
    dispatch({
      tmuxSessionId,
      state,
      injectText: buildHeartbeatInjectText(),
    }),
  );
  const reason = readString(result?.reason);
  const next: HeartbeatState = {
    ...state,
    updatedAtMs: at,
  };

  if (result?.disable) {
    next.enabled = false;
    if (reason) {
      next.lastSkippedReason = reason;
      next.lastError = reason;
    }
    await saveHeartbeatState(next);
    return;
  }

  if (result?.ok) {
    next.lastTriggeredAtMs = at;
    next.triggerCount = Math.max(0, Number(next.triggerCount) || 0) + 1;
    next.lastError = undefined;
    next.lastSkippedAtMs = undefined;
    next.lastSkippedReason = undefined;
    await saveHeartbeatState(next);
    return;
  }

  if (result?.skipped) {
    next.lastSkippedAtMs = at;
    next.lastSkippedReason = reason || "skipped";
    next.lastError = undefined;
    await saveHeartbeatState(next);
    return;
  }

  next.lastError = reason || "dispatch_failed";
  await saveHeartbeatState(next);
}

async function tickOnce(): Promise<void> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  const dir = resolveHeartbeatDir(sessionDir);
  await ensureDir(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const at = nowMs();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      await processHeartbeatStateFile(path.join(dir, entry.name), at);
    } catch {
      // best-effort per file
    }
  }
}

export function setHeartbeatRuntimeHooks(hooks?: HeartbeatRuntimeHooks): void {
  runtimeHooks = hooks;
}

export function resetHeartbeatRuntimeHooksForTests(): void {
  runtimeHooks = undefined;
}

export async function startHeartbeatDaemonIfNeeded(
  config?: unknown,
): Promise<void> {
  daemonConfig = normalizeHeartbeatConfig(config);
  if (daemonStarted) {
    await tickOnce();
    return;
  }
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  daemonStarted = true;
  await tickOnce();
  if ((daemonConfig?.tickMs || 0) > 0) {
    daemonTimer = setInterval(() => {
      void tickOnce();
    }, daemonConfig!.tickMs);
    daemonTimer.unref?.();
  }
}

export async function stopHeartbeatDaemonForTests(): Promise<void> {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = undefined;
  }
  daemonStarted = false;
  daemonConfig = undefined;
}

export async function runHeartbeatDaemonTickForTests(): Promise<void> {
  await tickOnce();
}
