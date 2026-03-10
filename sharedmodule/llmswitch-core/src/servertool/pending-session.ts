import fs from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject } from '../conversion/hub/types/json.js';
import { readJsonFile, writeJsonFileAtomic } from './clock/io.js';

export interface PendingServerToolInjection {
  version: 1;
  sessionId: string;
  createdAtMs: number;
  /**
   * Client tool_call ids that must appear in the next request's tool messages
   * before we apply the pending servertool injection.
   */
  afterToolCallIds: string[];
  /**
   * Chat messages to inject (assistant tool_call message + tool result messages).
   */
  messages: JsonObject[];
  sourceRequestId?: string;
}

function readSessionDirEnv(): string {
  return String(process.env.ROUTECODEX_SESSION_DIR || '').trim();
}

function sanitizeSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolvePendingDir(sessionDir: string): string {
  return path.join(sessionDir, 'servertool-pending');
}

function resolvePendingFile(sessionDir: string, sessionId: string): string | null {
  const safe = sanitizeSegment(sessionId);
  if (!safe) return null;
  return path.join(resolvePendingDir(sessionDir), `${safe}.json`);
}

function coercePending(value: unknown): PendingServerToolInjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId.trim() : '';
  const createdAtMs =
    typeof rec.createdAtMs === 'number' && Number.isFinite(rec.createdAtMs) ? Math.floor(rec.createdAtMs) : 0;
  const afterToolCallIds = Array.isArray(rec.afterToolCallIds)
    ? (rec.afterToolCallIds as unknown[]).filter((x) => typeof x === 'string' && x.trim().length).map((x) => String(x).trim())
    : [];
  const messages = Array.isArray(rec.messages)
    ? (rec.messages as unknown[]).filter((m) => m && typeof m === 'object' && !Array.isArray(m)) as JsonObject[]
    : [];
  if (!sessionId || !createdAtMs || !afterToolCallIds.length || !messages.length) {
    return null;
  }
  const sourceRequestId = typeof rec.sourceRequestId === 'string' && rec.sourceRequestId.trim().length
    ? rec.sourceRequestId.trim()
    : undefined;
  return {
    version: 1,
    sessionId,
    createdAtMs,
    afterToolCallIds,
    messages,
    ...(sourceRequestId ? { sourceRequestId } : {})
  };
}

export async function savePendingServerToolInjection(
  sessionId: string,
  pending: Omit<PendingServerToolInjection, 'version' | 'sessionId'>
): Promise<void> {
  const base = readSessionDirEnv();
  if (!base) return;
  const file = resolvePendingFile(base, sessionId);
  if (!file) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload: PendingServerToolInjection = {
    version: 1,
    sessionId,
    createdAtMs: pending.createdAtMs,
    afterToolCallIds: pending.afterToolCallIds,
    messages: pending.messages,
    ...(pending.sourceRequestId ? { sourceRequestId: pending.sourceRequestId } : {})
  };
  await writeJsonFileAtomic(file, payload);
}

export async function loadPendingServerToolInjection(sessionId: string): Promise<PendingServerToolInjection | null> {
  const base = readSessionDirEnv();
  if (!base) return null;
  const file = resolvePendingFile(base, sessionId);
  if (!file) return null;
  try {
    const raw = await readJsonFile(file);
    return coercePending(raw);
  } catch {
    return null;
  }
}

export async function clearPendingServerToolInjection(sessionId: string): Promise<void> {
  const base = readSessionDirEnv();
  if (!base) return;
  const file = resolvePendingFile(base, sessionId);
  if (!file) return;
  try {
    await fs.rm(file, { force: true });
  } catch {
    // ignore
  }
}

