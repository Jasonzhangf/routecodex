import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../clock/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../clock/io.js";
import { nowMs } from "../clock/state.js";
import { readSessionDirEnv, resolveHeartbeatDir, resolveHeartbeatStateFile } from "./paths.js";
import type { HeartbeatState } from "./types.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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
  if (!filePath) {
    return buildHeartbeatState(tmuxSessionId);
  }
  try {
    const raw = await readJsonFile(filePath);
    return coerceHeartbeatState(raw, tmuxSessionId);
  } catch {
    return buildHeartbeatState(tmuxSessionId);
  }
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
): Promise<HeartbeatState> {
  const state = await loadHeartbeatState(tmuxSessionId);
  const next: HeartbeatState = {
    ...state,
    enabled,
    updatedAtMs: nowMs(),
    ...(enabled
      ? {
          lastTriggeredAtMs: undefined,
          lastSkippedAtMs: undefined,
          lastSkippedReason: undefined,
          lastError: undefined,
        }
      : { lastSkippedReason: "disabled_by_directive" }),
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
  if (!filePath) {
    return;
  }
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // ignore
  }
}

export async function listHeartbeatStates(): Promise<HeartbeatState[]> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return [];
  }
  const dir = resolveHeartbeatDir(sessionDir);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: HeartbeatState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const tmuxSessionId = entry.name.slice(0, -".json".length);
      try {
        const raw = await readJsonFile(path.join(dir, entry.name));
        out.push(coerceHeartbeatState(raw, tmuxSessionId));
      } catch {
        out.push(buildHeartbeatState(tmuxSessionId));
      }
    }
    return out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  } catch {
    return [];
  }
}
