import fs from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planPendingSessionLoadWithNative,
  planPendingSessionSaveWithNative,
  resolvePendingSessionFileNameWithNative,
  resolvePendingSessionMaxAgeMsWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export const SERVERTOOL_PENDING_SESSION_FEATURE_ID = 'feature_id: hub.servertool_pending_session';

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

function isMissingFileError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === 'string'
    && (error as { code: string }).code === 'ENOENT';
}

async function readPendingJsonFile(file: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[servertool-pending] pending injection JSON parse failed file=${file} reason=${message}`);
  }
}

async function writeJsonFileAtomic(file: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function requireSessionDir(sessionDir: string | undefined): string {
  const value = typeof sessionDir === 'string' ? sessionDir.trim() : '';
  if (!value) {
    throw new Error('[servertool-pending] sessionDir missing; runtime metadata workdir root is required');
  }
  return value;
}

function resolvePendingMaxAgeMs(): number {
  const raw = String(
    process.env.ROUTECODEX_SERVERTOOL_PENDING_MAX_AGE_MS
    ?? process.env.RCC_SERVERTOOL_PENDING_MAX_AGE_MS
    ?? ''
  ).trim();
  return resolvePendingSessionMaxAgeMsWithNative(raw || undefined);
}

function resolvePendingDir(sessionDir: string): string {
  return path.join(sessionDir, 'servertool-pending');
}

function resolvePendingFile(sessionDir: string, sessionId: string): string | null {
  const fileName = resolvePendingSessionFileNameWithNative(sessionId);
  return fileName ? path.join(resolvePendingDir(sessionDir), fileName) : null;
}

async function removePlannedDropFile(file: string, message: string): Promise<void> {
  await fs.rm(file, { force: true });
  console.warn(message);
}

export async function savePendingServerToolInjection(
  sessionId: string,
  pending: Omit<PendingServerToolInjection, 'version' | 'sessionId'>,
  sessionDir: string
): Promise<void> {
  const base = requireSessionDir(sessionDir);
  const savePlan = planPendingSessionSaveWithNative({
    sessionId,
    pending: pending as Record<string, unknown>
  });
  if (!savePlan) return;
  const file = path.join(resolvePendingDir(base), savePlan.fileName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonFileAtomic(file, savePlan.payload);
}

export async function loadPendingServerToolInjection(
  sessionId: string,
  sessionDir: string
): Promise<PendingServerToolInjection | null> {
  const base = requireSessionDir(sessionDir);
  const file = resolvePendingFile(base, sessionId);
  if (!file) return null;
  const raw = await readPendingJsonFile(file);
  if (raw === null) return null;
  const maxAgeMs = resolvePendingMaxAgeMs();
  const plan = planPendingSessionLoadWithNative({
    raw,
    nowMs: Date.now(),
    maxAgeMs
  });
  if (plan.action === 'drop') {
    await removePlannedDropFile(file, plan.message);
    return null;
  }
  return plan.pending as PendingServerToolInjection;
}

export async function clearPendingServerToolInjection(
  sessionId: string,
  sessionDir: string
): Promise<void> {
  const base = requireSessionDir(sessionDir);
  const file = resolvePendingFile(base, sessionId);
  if (!file) return;
  await fs.rm(file, { force: true });
}
