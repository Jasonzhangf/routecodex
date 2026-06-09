import fs from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planPendingSessionLoadWithNative,
  planPendingSessionSaveWithNative,
  resolvePendingSessionFileNameWithNative,
  resolvePendingSessionMaxAgeMsWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { resolveRccPath } from '../runtime/user-data-paths.js';

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

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonFileAtomic(file: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function readSessionDirEnv(): string {
  const envValue = String(
    process.env.ROUTECODEX_SESSION_DIR
    || process.env.RCC_SESSION_DIR
    || ''
  ).trim();
  if (envValue) {
    return envValue;
  }
  try {
    return resolveRccPath('sessions');
  } catch {
    return '';
  }
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

async function dropPendingFile(file: string, message: string): Promise<void> {
  try {
    await fs.rm(file, { force: true });
  } catch {
    // keep original reason visible even if cleanup fails
  }
  try {
    console.warn(message);
  } catch {
    // no-op
  }
}

export async function savePendingServerToolInjection(
  sessionId: string,
  pending: Omit<PendingServerToolInjection, 'version' | 'sessionId'>
): Promise<void> {
  const base = readSessionDirEnv();
  if (!base) return;
  const savePlan = planPendingSessionSaveWithNative({
    sessionId,
    pending: pending as Record<string, unknown>
  });
  if (!savePlan) return;
  const file = path.join(resolvePendingDir(base), savePlan.fileName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonFileAtomic(file, savePlan.payload);
}

export async function loadPendingServerToolInjection(sessionId: string): Promise<PendingServerToolInjection | null> {
  const base = readSessionDirEnv();
  if (!base) return null;
  const file = resolvePendingFile(base, sessionId);
  if (!file) return null;
  try {
    const raw = await readJsonFile(file);
    const maxAgeMs = resolvePendingMaxAgeMs();
    const plan = planPendingSessionLoadWithNative({
      raw,
      nowMs: Date.now(),
      maxAgeMs
    });
    if (plan.action === 'drop') {
      await dropPendingFile(file, plan.message);
      return null;
    }
    return plan.pending as PendingServerToolInjection;
  } catch (error) {
    const code = typeof (error as { code?: unknown } | null)?.code === 'string'
      ? String((error as { code: string }).code)
      : '';
    if (code !== 'ENOENT') {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      await dropPendingFile(file, `[servertool-pending] pending injection read failed session=${sessionId} reason=${message}`);
    }
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
