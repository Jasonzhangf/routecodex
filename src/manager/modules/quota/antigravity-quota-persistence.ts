import fs from 'node:fs';
import path from 'node:path';
import fsAsync from 'node:fs/promises';

import type { QuotaStoreSnapshot } from '../../../modules/llmswitch/bridge.js';
import { loadProviderQuotaSnapshot } from '../../quota/provider-quota-store.js';

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

export function resolveQuotaManagerDir(resolveHomeDir: () => string): string {
  const base = path.join(resolveHomeDir(), '.routecodex', 'quota');
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {
    // ignore
  }
  return base;
}

export function resolveQuotaStatePath(resolveHomeDir: () => string): string {
  const baseDir = path.join(resolveHomeDir(), '.routecodex', 'state', 'quota');
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch {
    // best effort
  }
  return path.join(baseDir, 'antigravity.json');
}

export function loadAntigravitySnapshotFromDisk(resolveHomeDir: () => string): Record<string, QuotaRecordLike> {
  const filePath = resolveQuotaStatePath(resolveHomeDir);
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
  } catch {
    return {};
  }
}

export async function saveAntigravitySnapshotToDisk(
  resolveHomeDir: () => string,
  snapshot: Record<string, QuotaRecordLike>
): Promise<void> {
  const filePath = resolveQuotaStatePath(resolveHomeDir);
  try {
    await fsAsync.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  } catch {
    // best effort
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
      } catch {
        primaryExists = false;
      }
      try {
        const raw = await fsAsync.readFile(filePath, 'utf8');
        const parsed = JSON.parse(String(raw || '').trim() || 'null') as QuotaStoreSnapshot | null;
        if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
          options.onStatus('loaded');
          return parsed;
        }
      } catch {
        primaryLoadFailed = primaryExists;
      }

      try {
        const legacy = await loadProviderQuotaSnapshot();
        if (legacy && legacy.providers && typeof legacy.providers === 'object') {
          const nowMs = Date.now();
          options.onStatus('loaded');
          return {
            savedAtMs: Number.isFinite(Date.parse(legacy.updatedAt)) ? Date.parse(legacy.updatedAt) : nowMs,
            providers: legacy.providers as any
          };
        }
      } catch {
        // ignore
      }
      options.onStatus(primaryLoadFailed ? 'load_error' : 'missing');
      return null;
    },
    save: async (snapshot: QuotaStoreSnapshot) => {
      try {
        await fsAsync.mkdir(dir, { recursive: true });
      } catch {
        // ignore
      }
      const tmp = `${filePath}.tmp`;
      const text = `${JSON.stringify(snapshot, null, 2)}\n`;
      try {
        await fsAsync.writeFile(tmp, text, 'utf8');
        await fsAsync.rename(tmp, filePath);
        options.onStatus('loaded');
      } catch {
        options.onStatus('save_error');
        options.onSessionUnbindIssue('quota_store_save_error');
        try {
          await fsAsync.unlink(tmp);
        } catch {
          // ignore
        }
      }
    }
  };
}
