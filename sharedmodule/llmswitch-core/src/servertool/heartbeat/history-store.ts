import fs from "node:fs/promises";

import { ensureDir } from "../clock/paths.js";
import { nowMs } from "../clock/state.js";
import {
  readSessionDirEnv,
  resolveHeartbeatHistoryDir,
  resolveHeartbeatHistoryFile,
} from "./paths.js";
import type { HeartbeatHistoryEvent } from "./types.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  const floored = Math.floor(parsed);
  if (floored < 1) {
    return 1;
  }
  return Math.min(floored, 1000);
}

function coerceHistoryEvent(raw: unknown, fallbackTmuxSessionId: string): HeartbeatHistoryEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const tmuxSessionId = readString(row.tmuxSessionId) || fallbackTmuxSessionId;
  const source = readString(row.source);
  const action = readString(row.action);
  const outcome = readString(row.outcome);
  if (!tmuxSessionId || !source || !action || !outcome) {
    return null;
  }
  const atMsRaw = Number(row.atMs);
  const atMs = Number.isFinite(atMsRaw) ? Math.floor(atMsRaw) : nowMs();
  const details =
    row.details && typeof row.details === "object" && !Array.isArray(row.details)
      ? (row.details as Record<string, unknown>)
      : undefined;
  return {
    version: 1,
    atMs,
    tmuxSessionId,
    source,
    action,
    outcome,
    ...(readString(row.reason) ? { reason: readString(row.reason) } : {}),
    ...(details ? { details } : {}),
  };
}

export async function appendHeartbeatHistoryEvent(input: {
  tmuxSessionId: string;
  source: string;
  action: string;
  outcome: string;
  reason?: string;
  details?: Record<string, unknown>;
  atMs?: number;
}): Promise<boolean> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return false;
  }
  const tmuxSessionId = readString(input.tmuxSessionId);
  const source = readString(input.source);
  const action = readString(input.action);
  const outcome = readString(input.outcome);
  if (!tmuxSessionId || !source || !action || !outcome) {
    return false;
  }
  const filePath = resolveHeartbeatHistoryFile(sessionDir, tmuxSessionId);
  if (!filePath) {
    return false;
  }

  const event: HeartbeatHistoryEvent = {
    version: 1,
    atMs:
      typeof input.atMs === "number" && Number.isFinite(input.atMs)
        ? Math.floor(input.atMs)
        : nowMs(),
    tmuxSessionId,
    source,
    action,
    outcome,
    ...(readString(input.reason) ? { reason: readString(input.reason) } : {}),
    ...(input.details && Object.keys(input.details).length > 0
      ? { details: input.details }
      : {}),
  };

  try {
    await ensureDir(resolveHeartbeatHistoryDir(sessionDir));
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function listHeartbeatHistory(args: {
  tmuxSessionId: string;
  limit?: number;
}): Promise<HeartbeatHistoryEvent[]> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return [];
  }
  const tmuxSessionId = readString(args.tmuxSessionId);
  if (!tmuxSessionId) {
    return [];
  }
  const filePath = resolveHeartbeatHistoryFile(sessionDir, tmuxSessionId);
  if (!filePath) {
    return [];
  }
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const indexedEvents: Array<{ event: HeartbeatHistoryEvent; lineIndex: number }> = [];
  let lineIndex = 0;
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const event = coerceHistoryEvent(parsed, tmuxSessionId);
      if (event) {
        indexedEvents.push({ event, lineIndex });
      }
    } catch {
      // ignore malformed line
    }
    lineIndex += 1;
  }
  if (indexedEvents.length < 1) {
    return [];
  }
  indexedEvents.sort((a, b) => {
    if (b.event.atMs !== a.event.atMs) {
      return b.event.atMs - a.event.atMs;
    }
    return b.lineIndex - a.lineIndex;
  });
  return indexedEvents
    .slice(0, normalizeLimit(args.limit))
    .map(({ event }) => event);
}
