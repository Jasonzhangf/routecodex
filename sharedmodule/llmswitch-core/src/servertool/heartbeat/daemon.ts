import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, readSessionDirEnv } from "../clock/paths.js";
import { readJsonFile } from "../clock/io.js";
import { nowMs } from "../clock/state.js";
import {
  normalizeHeartbeatConfig,
  resolveHeartbeatScanMs,
} from "./config.js";
import { resolveHeartbeatDir } from "./paths.js";
import {
  coerceHeartbeatState,
  saveHeartbeatState,
} from "./session-store.js";
import { buildHeartbeatScheduleDiagnostic } from "./schedule-diagnostics.js";
import type {
  HeartbeatConfigSnapshot,
  HeartbeatDispatchResult,
  HeartbeatState,
} from "./types.js";
import { appendHeartbeatHistoryEvent } from "./history-store.js";

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

function effectiveIntervalMs(
  state: HeartbeatState,
  config: HeartbeatConfigSnapshot,
): number {
  return typeof state.intervalMs === "number" && Number.isFinite(state.intervalMs) && state.intervalMs > 0
    ? Math.floor(state.intervalMs)
    : config.tickMs;
}

function scheduleHeartbeatTimer(): void {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = undefined;
  }
  if (!daemonStarted || !daemonConfig || daemonConfig.tickMs < 1) {
    return;
  }
  const scanMs = resolveHeartbeatScanMs(daemonConfig);
  daemonTimer = setInterval(() => {
    void tickOnce();
  }, scanMs);
  daemonTimer.unref?.();
}

export function buildHeartbeatInjectText(): string {
  return [
    "[Heartbeat]",
    "请先判断你当前是否仍在执行上一次已开始的任务。",
    "如果当前任务仍在执行中，请忽略本次提醒，不要打断当前工作。",
    "如果当前任务已经空闲或已中断，请读取当前目录的 HEARTBEAT.md 进行任务巡检。",
    "你必须在 HEARTBEAT.md 顶部维护心跳停止条件（例如：Heartbeat-Stop-When: no-open-tasks）。",
    "当 HEARTBEAT.md 已无未完成任务，或已不具备可执行任务时，系统会自动停用该 tmux 会话 heartbeat。",
    "先检查上一次交付是否完整、是否还需要继续修复。",
    "完成后更新 DELIVERY.md（最多只保留最近十次交付记录，不要无限追加成巨型文件），然后调用 drudge.review。",
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
  return at - state.lastTriggeredAtMs >= effectiveIntervalMs(state, config);
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
    await appendHeartbeatHistoryEvent({
      tmuxSessionId: fallbackTmuxSessionId,
      source: "daemon.tick",
      action: "state_invalid",
      outcome: "failed",
      reason: "tmux_session_id_missing",
    });
    return;
  }

  const isAlive = runtimeHooks?.isTmuxSessionAlive;
  if (isAlive) {
    const alive = await Promise.resolve(isAlive(tmuxSessionId));
    if (!alive) {
      const next: HeartbeatState = {
        ...state,
        enabled: false,
        updatedAtMs: at,
        lastSkippedAtMs: at,
        lastSkippedReason: "tmux_session_not_found",
        lastError: "tmux_session_not_found",
      };
      await saveHeartbeatState(next);
      await appendHeartbeatHistoryEvent({
        tmuxSessionId,
        source: "daemon.tick",
        action: "availability",
        outcome: "disabled",
        reason: "tmux_session_not_found",
      });
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
  const scheduleDiagnosticBase = buildHeartbeatScheduleDiagnostic({
    state,
    config: effective,
    atMs: at,
    phase: result?.disable
      ? "disabled"
      : result?.ok
        ? "triggered"
        : result?.skipped
          ? "skipped"
          : "failed",
    ...(reason ? { reason } : {}),
  });
  const next: HeartbeatState = {
    ...state,
    updatedAtMs: at,
    lastScheduleDiagnostic: scheduleDiagnosticBase,
  };

  if (result?.disable) {
    next.enabled = false;
    if (reason) {
      next.lastSkippedReason = reason;
      next.lastError = reason;
    }
    await saveHeartbeatState(next);
    await appendHeartbeatHistoryEvent({
      tmuxSessionId,
      source: "daemon.tick",
      action: "trigger",
      outcome: "disabled",
      ...(reason ? { reason } : {}),
      details: { scheduleDiagnostic: scheduleDiagnosticBase },
    });
    return;
  }

  if (result?.ok) {
    next.lastTriggeredAtMs = at;
    next.triggerCount = Math.max(0, Number(next.triggerCount) || 0) + 1;
    next.lastError = undefined;
    next.lastSkippedAtMs = undefined;
    next.lastSkippedReason = undefined;
    await saveHeartbeatState(next);
    await appendHeartbeatHistoryEvent({
      tmuxSessionId,
      source: "daemon.tick",
      action: "trigger",
      outcome: "triggered",
      details: { scheduleDiagnostic: scheduleDiagnosticBase },
    });
    return;
  }

  if (result?.skipped) {
    next.lastSkippedAtMs = at;
    next.lastSkippedReason = reason || "skipped";
    next.lastError = undefined;
    await saveHeartbeatState(next);
    await appendHeartbeatHistoryEvent({
      tmuxSessionId,
      source: "daemon.tick",
      action: "trigger",
      outcome: "skipped",
      reason: reason || "skipped",
      details: { scheduleDiagnostic: scheduleDiagnosticBase },
    });
    return;
  }

  next.lastError = reason || "dispatch_failed";
  await saveHeartbeatState(next);
  await appendHeartbeatHistoryEvent({
    tmuxSessionId,
    source: "daemon.tick",
    action: "trigger",
    outcome: "failed",
    reason: reason || "dispatch_failed",
    details: { scheduleDiagnostic: scheduleDiagnosticBase },
  });
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
    scheduleHeartbeatTimer();
    await tickOnce();
    return;
  }
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  daemonStarted = true;
  await tickOnce();
  scheduleHeartbeatTimer();
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
