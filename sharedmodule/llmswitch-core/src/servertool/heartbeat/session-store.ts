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
import type { HeartbeatState } from "./types.js";

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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
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
  } catch {
    // best-effort legacy scan only
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
    } catch {
      // fall through to legacy scan
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
      } catch {
        // best-effort legacy cleanup
      }
      return migrated;
    } catch {
      // try next legacy candidate
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
  options?: { intervalMs?: number; clearIntervalOverride?: boolean },
): Promise<HeartbeatState> {
  const state = await loadHeartbeatState(tmuxSessionId);
  const intervalMs = normalizePositiveInt(options?.intervalMs);
  const clearIntervalOverride = options?.clearIntervalOverride === true;
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
      : { intervalMs: undefined, lastSkippedReason: "disabled_by_directive" }),
  };
  await saveHeartbeatState(next);
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
    } catch {
      // ignore
    }
  }
  const legacyFiles = await resolveLegacyHeartbeatStateFiles(sessionDir, tmuxSessionId);
  for (const legacyFilePath of legacyFiles) {
    try {
      await fs.rm(legacyFilePath, { force: true });
    } catch {
      // ignore
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
    } catch {
      // best-effort listing only
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
        } catch {
          const fallback = buildHeartbeatState(tmuxSessionId);
          const prev = merged.get(fallback.tmuxSessionId);
          if (!prev || fallback.updatedAtMs >= prev.updatedAtMs) {
            merged.set(fallback.tmuxSessionId, fallback);
          }
        }
      }
    } catch {
      // ignore missing directories
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
