import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { QuotaState } from './provider-quota-center.js';

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

function resolveQuotaDir(): string {
  const override = String(process.env.ROUTECODEX_QUOTA_DIR || process.env.RCC_QUOTA_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }
  const home = os.homedir();
  return path.join(home, '.routecodex', 'quota');
}

function resolveQuotaSnapshotPath(): string {
  return path.join(resolveQuotaDir(), 'provider-quota.json');
}

function resolveErrorLogPath(): string {
  return path.join(resolveQuotaDir(), 'provider-errors.ndjson');
}

export async function loadProviderQuotaSnapshot(): Promise<ProviderQuotaSnapshot | null> {
  const filePath = resolveQuotaSnapshotPath();
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
  } catch {
    return null;
  }
}

export async function saveProviderQuotaSnapshot(
  providers: Record<string, QuotaState>,
  now: Date = new Date()
): Promise<void> {
  const dir = resolveQuotaDir();
  const filePath = resolveQuotaSnapshotPath();
  const payload: ProviderQuotaSnapshot = {
    version: 1,
    updatedAt: now.toISOString(),
    providers
  };

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // best-effort
  }

  const tmpPath = `${filePath}.tmp`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, text, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch {
    // 写入失败不应影响主流程
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
  }
}

export async function appendProviderErrorEvent(event: ProviderErrorEventRecord): Promise<void> {
  const dir = resolveQuotaDir();
  const filePath = resolveErrorLogPath();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // best-effort
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
  } catch {
    // 追加失败不影响主流程
  }
}
