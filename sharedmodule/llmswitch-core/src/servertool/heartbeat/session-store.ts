import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../clock/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../clock/io.js";
import { nowMs } from "../clock/state.js";
import {
  readSessionDirEnv,
  resolveHeartbeatDir,
  resolveHeartbeatStateFile,
  resolveHeartbeatStateFileInDir,
  resolveLegacyHeartbeatDir,
  resolveHeartbeatStoreBaseDir,
} from "./paths.js";
import type {
  HeartbeatCronShadowDiagnostic,
  HeartbeatScheduleDiagnostic,
  HeartbeatState,
} from "./types.js";
import { appendHeartbeatHistoryEvent } from "./history-store.js";

function logHeartbeatSessionStoreNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {},
): void {
  const reason =
    error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
  const detailSuffix =
    Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : "";
  console.warn(
    `[heartbeat-session-store] ${stage} failed (non-blocking): ${reason}${detailSuffix}`,
  );
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored >= 0 ? floored : undefined;
}

function coerceCronShadowDiagnostic(
  raw: unknown,
): HeartbeatCronShadowDiagnostic | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (row.supported === true) {
    const expression = readString(row.expression);
    const timezone = readString(row.timezone);
    const previousBoundaryAtMs = normalizeNonNegativeInt(row.previousBoundaryAtMs);
    const nextBoundaryAtMs = normalizeNonNegativeInt(row.nextBoundaryAtMs);
    const offsetFromPreviousBoundaryMs = normalizeNonNegativeInt(
      row.offsetFromPreviousBoundaryMs,
    );
    if (
      !expression ||
      !timezone ||
      typeof previousBoundaryAtMs !== "number" ||
      typeof nextBoundaryAtMs !== "number" ||
      typeof offsetFromPreviousBoundaryMs !== "number"
    ) {
      return undefined;
    }
    return {
      supported: true,
      expression,
      timezone,
      previousBoundaryAtMs,
      nextBoundaryAtMs,
      offsetFromPreviousBoundaryMs,
    };
  }
  if (row.supported === false) {
    const reason = readString(row.reason);
    return reason ? { supported: false, reason } : undefined;
  }
  return undefined;
}

function coerceScheduleDiagnostic(
  raw: unknown,
): HeartbeatScheduleDiagnostic | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  const phase = readString(row.phase);
  const observedAtMs = normalizePositiveInt(row.observedAtMs);
  const daemonScanMs = normalizePositiveInt(row.daemonScanMs);
  const effectiveIntervalMs = normalizePositiveInt(row.effectiveIntervalMs);
  const cronShadow = coerceCronShadowDiagnostic(row.cronShadow);
  if (
    !phase ||
    (phase !== "triggered" &&
      phase !== "skipped" &&
      phase !== "failed" &&
      phase !== "disabled") ||
    typeof observedAtMs !== "number" ||
    typeof daemonScanMs !== "number" ||
    typeof effectiveIntervalMs !== "number" ||
    !cronShadow
  ) {
    return undefined;
  }
  const anchorAtMs = normalizePositiveInt(row.anchorAtMs);
  const dueAtMs = normalizePositiveInt(row.dueAtMs);
  const dueInMsRaw = Number(row.dueInMs);
  const latenessMsRaw = Number(row.latenessMs);
  return {
    phase,
    observedAtMs,
    daemonScanMs,
    effectiveIntervalMs,
    ...(typeof anchorAtMs === "number" ? { anchorAtMs } : {}),
    ...(typeof dueAtMs === "number" ? { dueAtMs } : {}),
    ...(Number.isFinite(dueInMsRaw) ? { dueInMs: Math.floor(dueInMsRaw) } : {}),
    ...(Number.isFinite(latenessMsRaw)
      ? { latenessMs: Math.floor(latenessMsRaw) }
      : {}),
    ...(readString(row.reason) ? { reason: readString(row.reason) } : {}),
    cronShadow,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    logHeartbeatSessionStoreNonBlocking("path_exists.access", error, { filePath });
    return false;
  }
}

async function resolveLegacyHeartbeatStateFiles(
  sessionDir: string,
  tmuxSessionId: string,
): Promise<string[]> {
  const out = new Set<string>();
  const legacyDir = resolveLegacyHeartbeatDir(sessionDir);
  if (legacyDir) {
    const filePath = resolveHeartbeatStateFileInDir(legacyDir, tmuxSessionId);
    if (filePath && (await pathExists(filePath))) {
      out.add(filePath);
    }
  }

  const storeBaseDir = resolveHeartbeatStoreBaseDir(sessionDir);
  const normalizedSessionDir = path.resolve(sessionDir);
  if (storeBaseDir === normalizedSessionDir) {
    return Array.from(out);
  }

  try {
    const entries = await fs.readdir(storeBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "heartbeat") {
        continue;
      }
      const dirpath = path.join(storeBaseDir, entry.name, "heartbeat");
      if (legacyDir && path.resolve(dirpath) === path.resolve(legacyDir)) {
        continue;
      }
      const filePath = resolveHeartbeatStateFileInDir(dirpath, tmuxSessionId);
      if (filePath && (await pathExists(filePath))) {
        out.add(filePath);
      }
    }
  } catch (error) {
    logHeartbeatSessionStoreNonBlocking("resolve_legacy_state_files.scan_store_base", error, {
      storeBaseDir,
      tmuxSessionId,
    });
  }

  return Array.from(out);
}

export function buildHeartbeatState(tmuxSessionId: string): HeartbeatState {
  return {
    version: 1,
    tmuxSessionId,
    enabled: false,
    updatedAtMs: nowMs(),
    triggerCount: 0,
  };
}

export function coerceHeartbeatState(
  raw: unknown,
  fallbackTmuxSessionId: string,
): HeartbeatState {
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const tmuxSessionId = readString(row.tmuxSessionId) || fallbackTmuxSessionId;
  const triggerCountRaw = Number(row.triggerCount);
  const scheduleDiagnostic = coerceScheduleDiagnostic(row.lastScheduleDiagnostic);
  return {
    version: 1,
    tmuxSessionId,
    enabled: row.enabled === true,
    updatedAtMs:
      typeof row.updatedAtMs === "number" && Number.isFinite(row.updatedAtMs)
        ? Math.floor(row.updatedAtMs)
        : nowMs(),
    triggerCount:
      Number.isFinite(triggerCountRaw) && triggerCountRaw >= 0
        ? Math.floor(triggerCountRaw)
        : 0,
    ...(normalizePositiveInt(row.intervalMs)
      ? { intervalMs: normalizePositiveInt(row.intervalMs) }
      : {}),
    ...(typeof row.lastTriggeredAtMs === "number" &&
    Number.isFinite(row.lastTriggeredAtMs)
      ? { lastTriggeredAtMs: Math.floor(row.lastTriggeredAtMs) }
      : {}),
    ...(typeof row.lastSkippedAtMs === "number" &&
    Number.isFinite(row.lastSkippedAtMs)
      ? { lastSkippedAtMs: Math.floor(row.lastSkippedAtMs) }
      : {}),
    ...(readString(row.lastSkippedReason)
      ? { lastSkippedReason: readString(row.lastSkippedReason) }
      : {}),
    ...(readString(row.lastError) ? { lastError: readString(row.lastError) } : {}),
    ...(scheduleDiagnostic ? { lastScheduleDiagnostic: scheduleDiagnostic } : {}),
  };
}

export async function loadHeartbeatState(
  tmuxSessionId: string,
): Promise<HeartbeatState> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return buildHeartbeatState(tmuxSessionId);
  }
  const filePath = resolveHeartbeatStateFile(sessionDir, tmuxSessionId);
  if (filePath) {
    try {
      const raw = await readJsonFile(filePath);
      return coerceHeartbeatState(raw, tmuxSessionId);
    } catch (error) {
      logHeartbeatSessionStoreNonBlocking("load_state.primary_read", error, {
        filePath,
        tmuxSessionId,
      });
    }
  }

  const legacyFiles = await resolveLegacyHeartbeatStateFiles(sessionDir, tmuxSessionId);
  for (const legacyFilePath of legacyFiles) {
    try {
      const raw = await readJsonFile(legacyFilePath);
      const migrated = coerceHeartbeatState(raw, tmuxSessionId);
      if (filePath) {
        await ensureDir(resolveHeartbeatDir(sessionDir));
        await writeJsonFileAtomic(filePath, migrated);
      }
      try {
        await fs.rm(legacyFilePath, { force: true });
      } catch (error) {
        logHeartbeatSessionStoreNonBlocking("load_state.cleanup_legacy_file", error, {
          legacyFilePath,
          tmuxSessionId,
        });
      }
      return migrated;
    } catch (error) {
      logHeartbeatSessionStoreNonBlocking("load_state.read_legacy_candidate", error, {
        legacyFilePath,
        tmuxSessionId,
      });
    }
  }

  return buildHeartbeatState(tmuxSessionId);
}

export async function saveHeartbeatState(state: HeartbeatState): Promise<void> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  const filePath = resolveHeartbeatStateFile(sessionDir, state.tmuxSessionId);
  if (!filePath) {
    return;
  }
  await ensureDir(resolveHeartbeatDir(sessionDir));
  await writeJsonFileAtomic(filePath, state);
}

export async function setHeartbeatEnabled(
  tmuxSessionId: string,
  enabled: boolean,
  options?: {
    intervalMs?: number;
    clearIntervalOverride?: boolean;
    source?: string;
    reason?: string;
    details?: Record<string, unknown>;
  },
): Promise<HeartbeatState> {
  const state = await loadHeartbeatState(tmuxSessionId);
  const intervalMs = normalizePositiveInt(options?.intervalMs);
  const clearIntervalOverride = options?.clearIntervalOverride === true;
  const disabledReason = readString(options?.reason) || "disabled_by_directive";
  const next: HeartbeatState = {
    ...state,
    enabled,
    updatedAtMs: nowMs(),
    ...(enabled
      ? {
          ...(intervalMs
            ? { intervalMs }
            : clearIntervalOverride
              ? { intervalMs: undefined }
              : {}),
          lastTriggeredAtMs: undefined,
          lastSkippedAtMs: undefined,
          lastSkippedReason: undefined,
          lastError: undefined,
        }
      : { intervalMs: undefined, lastSkippedReason: disabledReason, lastError: disabledReason }),
  };
  await saveHeartbeatState(next);
  await appendHeartbeatHistoryEvent({
    tmuxSessionId: next.tmuxSessionId,
    source: readString(options?.source) || "state.set",
    action: "set_enabled",
    outcome: enabled ? "enabled" : "disabled",
    ...(enabled ? {} : { reason: disabledReason }),
    ...(options?.details ? { details: options.details } : {}),
  });
  return next;
}

export async function removeHeartbeatState(tmuxSessionId: string): Promise<void> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  const filePath = resolveHeartbeatStateFile(sessionDir, tmuxSessionId);
  if (filePath) {
    try {
      await fs.rm(filePath, { force: true });
    } catch (error) {
      logHeartbeatSessionStoreNonBlocking("remove_state.primary_file", error, {
        filePath,
        tmuxSessionId,
      });
    }
  }
  const legacyFiles = await resolveLegacyHeartbeatStateFiles(sessionDir, tmuxSessionId);
  for (const legacyFilePath of legacyFiles) {
    try {
      await fs.rm(legacyFilePath, { force: true });
    } catch (error) {
      logHeartbeatSessionStoreNonBlocking("remove_state.legacy_file", error, {
        legacyFilePath,
        tmuxSessionId,
      });
    }
  }
}

export async function listHeartbeatStates(): Promise<HeartbeatState[]> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return [];
  }

  const dirs = new Set<string>([resolveHeartbeatDir(sessionDir)]);
  const legacyDir = resolveLegacyHeartbeatDir(sessionDir);
  if (legacyDir) {
    dirs.add(legacyDir);
  }
  const storeBaseDir = resolveHeartbeatStoreBaseDir(sessionDir);
  const normalizedSessionDir = path.resolve(sessionDir);
  if (storeBaseDir !== normalizedSessionDir) {
    try {
      const entries = await fs.readdir(storeBaseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "heartbeat") {
          continue;
        }
        dirs.add(path.join(storeBaseDir, entry.name, "heartbeat"));
      }
    } catch (error) {
      logHeartbeatSessionStoreNonBlocking("list_states.scan_store_base", error, {
        storeBaseDir,
      });
    }
  }

  const merged = new Map<string, HeartbeatState>();
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const tmuxSessionId = entry.name.slice(0, -".json".length);
        try {
          const raw = await readJsonFile(path.join(dir, entry.name));
          const state = coerceHeartbeatState(raw, tmuxSessionId);
          const prev = merged.get(state.tmuxSessionId);
          if (!prev || state.updatedAtMs >= prev.updatedAtMs) {
            merged.set(state.tmuxSessionId, state);
          }
        } catch (error) {
          const fallback = buildHeartbeatState(tmuxSessionId);
          const prev = merged.get(fallback.tmuxSessionId);
          if (!prev || fallback.updatedAtMs >= prev.updatedAtMs) {
            merged.set(fallback.tmuxSessionId, fallback);
          }
          logHeartbeatSessionStoreNonBlocking("list_states.read_state_file", error, {
            dir,
            file: entry.name,
            tmuxSessionId,
          });
        }
      }
    } catch (error) {
      logHeartbeatSessionStoreNonBlocking("list_states.read_directory", error, { dir });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
