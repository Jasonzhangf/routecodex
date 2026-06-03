import fs from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject } from '../conversion/hub/types/json.js';
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

const DEFAULT_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

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
  if (!raw) {
    return DEFAULT_PENDING_MAX_AGE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PENDING_MAX_AGE_MS;
  }
  return parsed;
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
    const pending = coercePending(raw);
    if (!pending) {
      await dropPendingFile(file, '[servertool-pending] invalid pending injection dropped: malformed payload');
      return null;
    }
    const maxAgeMs = resolvePendingMaxAgeMs();
    if (Date.now() - pending.createdAtMs > maxAgeMs) {
      await dropPendingFile(
        file,
        `[servertool-pending] stale pending injection dropped session=${pending.sessionId} ageMs=${Date.now() - pending.createdAtMs} maxAgeMs=${maxAgeMs}`
      );
      return null;
    }
    return pending;
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
