import fs from 'node:fs';
import path from 'node:path';
import fsAsync from 'node:fs/promises';
import {
  resolveRccQuotaDir,
  resolveRccStateDir
} from '../../../config/user-data-paths.js';

import type { QuotaStoreSnapshot } from '../../../modules/llmswitch/bridge.js';

export type QuotaStorePersistenceStatus =
  | 'unknown'
  | 'loaded'
  | 'missing'
  | 'load_error'
  | 'save_error';

export type QuotaRecordLike = {
  remainingFraction: number | null;
  resetAt?: number;
  fetchedAt: number;
};

function logAntigravityQuotaPersistenceNonBlockingError(
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const suffix = details ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[antigravity-quota-persistence] ${operation} failed (non-blocking): ${reason}${suffix}`);
}

export function resolveQuotaManagerDir(resolveHomeDir: () => string): string {
  const base = resolveRccQuotaDir(resolveHomeDir());
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (error) {
    logAntigravityQuotaPersistenceNonBlockingError('resolveQuotaManagerDir.mkdir', error, { base });
  }
  return base;
}

export function resolveQuotaStateWritePath(resolveHomeDir: () => string): string {
  const primaryBaseDir = path.join(resolveRccStateDir(resolveHomeDir()), 'quota');
  try {
    fs.mkdirSync(primaryBaseDir, { recursive: true });
  } catch (error) {
    logAntigravityQuotaPersistenceNonBlockingError('resolveQuotaStateWritePath.mkdir', error, { primaryBaseDir });
  }
  return path.join(primaryBaseDir, 'antigravity.json');
}

export function resolveQuotaStateReadPath(resolveHomeDir: () => string): string {
  return resolveQuotaStateWritePath(resolveHomeDir);
}

export function loadAntigravitySnapshotFromDisk(resolveHomeDir: () => string): Record<string, QuotaRecordLike> {
  const filePath = resolveQuotaStateReadPath(resolveHomeDir);
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = content.trim() ? JSON.parse(content) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const raw = parsed as Record<string, QuotaRecordLike>;
    const result: Record<string, QuotaRecordLike> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      let remainingFraction: number | null = null;
      if (typeof (value as { remainingFraction?: unknown }).remainingFraction === 'number') {
        remainingFraction = (value as { remainingFraction?: number }).remainingFraction ?? null;
      }
      let resetAt: number | undefined;
      if (typeof (value as { resetAt?: unknown }).resetAt === 'number') {
        resetAt = (value as { resetAt?: number }).resetAt;
      }
      const fetchedAt =
        typeof (value as { fetchedAt?: unknown }).fetchedAt === 'number'
          ? (value as { fetchedAt?: number }).fetchedAt!
          : Date.now();
      result[key] = { remainingFraction, resetAt, fetchedAt };
    }
    return result;
  } catch (error) {
    logAntigravityQuotaPersistenceNonBlockingError('loadAntigravitySnapshotFromDisk', error, { filePath });
    return {};
  }
}

export async function saveAntigravitySnapshotToDisk(
  resolveHomeDir: () => string,
  snapshot: Record<string, QuotaRecordLike>
): Promise<void> {
  const filePath = resolveQuotaStateWritePath(resolveHomeDir);
  try {
    await fsAsync.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  } catch (error) {
    logAntigravityQuotaPersistenceNonBlockingError('saveAntigravitySnapshotToDisk', error, { filePath });
  }
}

export function createQuotaStore(options: {
  resolveHomeDir: () => string;
  onStorePath: (path: string) => void;
  onStatus: (status: QuotaStorePersistenceStatus) => void;
  onSessionUnbindIssue: (reason: string) => void;
}): { load: () => Promise<QuotaStoreSnapshot | null>; save: (snapshot: QuotaStoreSnapshot) => Promise<void> } {
  const dir = resolveQuotaManagerDir(options.resolveHomeDir);
  const filePath = path.join(dir, 'quota-manager.json');
  options.onStorePath(filePath);
  return {
    load: async () => {
      let primaryLoadFailed = false;
      let primaryExists = false;
      try {
        primaryExists = fs.existsSync(filePath);
      } catch (error) {
        logAntigravityQuotaPersistenceNonBlockingError('createQuotaStore.load.existsSync', error, { filePath });
        primaryExists = false;
      }
      try {
        const raw = await fsAsync.readFile(filePath, 'utf8');
        const parsed = JSON.parse(String(raw || '').trim() || 'null') as QuotaStoreSnapshot | null;
        if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
          options.onStatus('loaded');
          return parsed;
        }
      } catch (error) {
        logAntigravityQuotaPersistenceNonBlockingError('createQuotaStore.load.readFile', error, { filePath });
        primaryLoadFailed = primaryExists;
      }
      options.onStatus(primaryLoadFailed ? 'load_error' : 'missing');
      return null;
    },
    save: async (snapshot: QuotaStoreSnapshot) => {
      try {
        await fsAsync.mkdir(dir, { recursive: true });
      } catch (error) {
        logAntigravityQuotaPersistenceNonBlockingError('createQuotaStore.save.mkdir', error, { dir });
      }
      const tmp = `${filePath}.tmp`;
      const text = `${JSON.stringify(snapshot, null, 2)}\n`;
      try {
        await fsAsync.writeFile(tmp, text, 'utf8');
        await fsAsync.rename(tmp, filePath);
        options.onStatus('loaded');
      } catch (error) {
        logAntigravityQuotaPersistenceNonBlockingError('createQuotaStore.save.write', error, { filePath, tmp });
        options.onStatus('save_error');
        options.onSessionUnbindIssue('quota_store_save_error');
        try {
          await fsAsync.unlink(tmp);
        } catch (cleanupError) {
          logAntigravityQuotaPersistenceNonBlockingError('createQuotaStore.save.cleanupTmp', cleanupError, { tmp });
        }
      }
    }
  };
}
