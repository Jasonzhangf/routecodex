import fs from 'node:fs/promises';
import path from 'node:path';

import type { ClockConfigSnapshot, ClockSessionState } from './types.js';
import { ensureDir, readSessionDirEnv, resolveClockStateFile } from './paths.js';
import { buildEmptyState, cleanExpiredTasks, coerceState, normalizeClockSessionMeta, nowMs } from './state.js';
import { readJsonFile, writeJsonFileAtomic } from './io.js';

function shouldPersistClockState(state: ClockSessionState): boolean {
  if (state.tasks.length > 0) {
    return true;
  }
  const meta = normalizeClockSessionMeta(state.meta);
  return meta.taskRevision > 0 || meta.listedRevision >= 0 || Number.isFinite(meta.lastListAtMs);
}

export async function loadClockSessionState(sessionId: string, config: ClockConfigSnapshot): Promise<ClockSessionState> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return buildEmptyState(sessionId);
  }
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  if (!filePath) {
    return buildEmptyState(sessionId);
  }
  try {
    const raw = await readJsonFile(filePath);
    const state = coerceState(raw, sessionId);
    const at = nowMs();
    const cleaned = cleanExpiredTasks(state.tasks, config, at);
    if (cleaned.length !== state.tasks.length) {
      const next: ClockSessionState = { ...state, tasks: cleaned, updatedAtMs: at };
      if (!shouldPersistClockState(next)) {
        await fs.rm(filePath, { force: true });
      } else {
        await ensureDir(path.dirname(filePath));
        await writeJsonFileAtomic(filePath, next);
      }
      return next;
    }
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    if (message.includes('ENOENT')) {
      return buildEmptyState(sessionId);
    }
    return buildEmptyState(sessionId);
  }
}

export async function clearClockSession(sessionId: string): Promise<void> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  if (!filePath) {
    return;
  }
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // ignore
  }
}
