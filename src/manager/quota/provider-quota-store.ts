import path from 'node:path';
import fs from 'node:fs/promises';
import type { QuotaState } from './provider-quota-center.js';
import { resolveRccQuotaDir, resolveRccQuotaDirForRead } from '../../config/user-data-paths.js';

export interface ProviderQuotaSnapshot {
  version: number;
  updatedAt: string;
  providers: Record<string, QuotaState>;
}

export interface ProviderErrorEventRecord {
  ts: string;
  providerKey: string;
  code?: string;
  httpStatus?: number;
  message?: string;
  details?: unknown;
}

const providerQuotaWriteChains = new Map<string, Promise<void>>();

function logProviderQuotaStoreNonBlockingError(operation: string, error: unknown, details?: Record<string, unknown>): void {
  const reason = error instanceof Error ? error.message : String(error);
  const suffix = details ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[provider-quota-store] ${operation} failed (non-blocking): ${reason}${suffix}`);
}

function enqueueSerializedQuotaWrite(filePath: string, task: () => Promise<void>): Promise<void> {
  const previous = providerQuotaWriteChains.get(filePath) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(task);
  providerQuotaWriteChains.set(filePath, current);
  return current.finally(() => {
    if (providerQuotaWriteChains.get(filePath) === current) {
      providerQuotaWriteChains.delete(filePath);
    }
  });
}

function parseHttpStatusFromCode(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const match =
    raw.match(/HTTP[_\-\s]?(\d{3})/i) ||
    raw.match(/STATUS[_\-\s]?(\d{3})/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldDropCooldownPersistence(state: QuotaState): boolean {
  if (!state || typeof state !== 'object') {
    return false;
  }
  if (state.reason !== 'cooldown') {
    return false;
  }
  if (state.lastErrorSeries === 'E5XX') {
    return true;
  }
  if (state.lastErrorSeries === 'EOTHER') {
    const status = parseHttpStatusFromCode(state.lastErrorCode);
    if (typeof status === 'number' && status >= 400 && status < 600 && status !== 429) {
      return true;
    }
  }
  return false;
}

function sanitizeQuotaStateForSnapshot(state: QuotaState): QuotaState {
  if (!shouldDropCooldownPersistence(state)) {
    return state;
  }
  return {
    ...state,
    inPool: true,
    reason: 'ok',
    cooldownUntil: null,
    lastErrorSeries: null,
    lastErrorCode: null,
    lastErrorAtMs: null,
    consecutiveErrorCount: 0,
    authIssue: null
  };
}

export { sanitizeQuotaStateForSnapshot };

function resolveQuotaDir(): string {
  const override = String(process.env.ROUTECODEX_QUOTA_DIR || process.env.RCC_QUOTA_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }
  return resolveRccQuotaDir();
}

function resolveQuotaSnapshotPath(): string {
  return path.join(resolveQuotaDir(), 'provider-quota.json');
}

function resolveErrorLogPath(): string {
  return path.join(resolveQuotaDir(), 'provider-errors.ndjson');
}

function resolveQuotaSnapshotReadPath(): string {
  const override = String(process.env.ROUTECODEX_QUOTA_DIR || process.env.RCC_QUOTA_DIR || '').trim();
  if (override) {
    const base = path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
    return path.join(base, 'provider-quota.json');
  }
  return path.join(resolveRccQuotaDirForRead(), 'provider-quota.json');
}

export async function loadProviderQuotaSnapshot(): Promise<ProviderQuotaSnapshot | null> {
  const filePath = resolveQuotaSnapshotReadPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed) as ProviderQuotaSnapshot;
    if (!parsed || typeof parsed !== 'object' || !parsed.providers || typeof parsed.providers !== 'object') {
      return null;
    }
    return parsed;
  } catch (error) {
    logProviderQuotaStoreNonBlockingError('loadProviderQuotaSnapshot', error, { filePath });
    return null;
  }
}

export async function saveProviderQuotaSnapshot(
  providers: Record<string, QuotaState>,
  now: Date = new Date()
): Promise<void> {
  const dir = resolveQuotaDir();
  const filePath = resolveQuotaSnapshotPath();
  const sanitizedProviders: Record<string, QuotaState> = {};
  for (const [providerKey, state] of Object.entries(providers || {})) {
    if (!state || typeof state !== 'object') {
      continue;
    }
    sanitizedProviders[providerKey] = sanitizeQuotaStateForSnapshot(state);
  }

  const payload: ProviderQuotaSnapshot = {
    version: 1,
    updatedAt: now.toISOString(),
    providers: sanitizedProviders
  };

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logProviderQuotaStoreNonBlockingError('saveProviderQuotaSnapshot.mkdir', error, { dir });
  }

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    await enqueueSerializedQuotaWrite(filePath, async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, text, 'utf8');
    });
  } catch (error) {
    logProviderQuotaStoreNonBlockingError('saveProviderQuotaSnapshot.write', error, { filePath });
  }
}

export async function appendProviderErrorEvent(event: ProviderErrorEventRecord): Promise<void> {
  const dir = resolveQuotaDir();
  const filePath = resolveErrorLogPath();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logProviderQuotaStoreNonBlockingError('appendProviderErrorEvent.mkdir', error, { dir });
  }
  const envelope = {
    ts: event.ts,
    providerKey: event.providerKey,
    ...(event.code ? { code: event.code } : {}),
    ...(typeof event.httpStatus === 'number' ? { httpStatus: event.httpStatus } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.details !== undefined ? { details: event.details } : {})
  };
  const line = `${JSON.stringify(envelope)}\n`;
  try {
    await fs.appendFile(filePath, line, 'utf8');
  } catch (error) {
    logProviderQuotaStoreNonBlockingError('appendProviderErrorEvent.append', error, { filePath });
  }
}
