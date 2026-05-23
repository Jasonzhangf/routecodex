import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendProviderErrorEvent,
  loadProviderQuotaSnapshot,
  saveProviderQuotaSnapshot,
  sanitizeQuotaStateForSnapshot
} from '../../../src/manager/quota/provider-quota-store.js';
import { createInitialQuotaState } from '../../../src/manager/quota/provider-quota-center.js';

function quotaDir(): string {
  const configured = String(process.env.ROUTECODEX_QUOTA_DIR || '').trim();
  if (!configured) {
    throw new Error('ROUTECODEX_QUOTA_DIR must be set for tests');
  }
  return configured;
}

describe('provider-quota-store snapshot', () => {
  const providerKey = 'test.provider.key';
  const originalQuotaDir = process.env.ROUTECODEX_QUOTA_DIR;
  let tempDir: string | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-test-'));
    process.env.ROUTECODEX_QUOTA_DIR = tempDir;
  });

  afterEach(async () => {
    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
    tempDir = null;
    if (originalQuotaDir === undefined) delete process.env.ROUTECODEX_QUOTA_DIR;
    else process.env.ROUTECODEX_QUOTA_DIR = originalQuotaDir;
  });

  it('saves and loads provider quota snapshot roundtrip', async () => {
    const now = new Date('2026-01-15T10:00:00.000Z');
    const state = createInitialQuotaState(providerKey, { priorityTier: 42 }, now.getTime());
    const snapshot = { [providerKey]: state };

    await saveProviderQuotaSnapshot(snapshot, now);
    const loaded = await loadProviderQuotaSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
    expect(loaded?.updatedAt).toBe(now.toISOString());
    expect(loaded?.providers[providerKey]).toBeDefined();
    expect(loaded?.providers[providerKey].priorityTier).toBe(42);
    expect(loaded?.providers[providerKey].providerKey).toBe(providerKey);
  });

  it('keeps cooldown persistence for restart-stable backoff state', async () => {
    const now = new Date('2026-01-15T10:10:00.000Z');
    const state = createInitialQuotaState(providerKey, { priorityTier: 42 }, now.getTime());
    const snapshot = {
      [providerKey]: {
        ...state,
        inPool: false,
        reason: 'cooldown',
        cooldownUntil: now.getTime() + 30_000,
        lastErrorSeries: 'EOTHER',
        lastErrorCode: 'HTTP_400',
        lastErrorAtMs: now.getTime(),
        consecutiveErrorCount: 2
      }
    };

    await saveProviderQuotaSnapshot(snapshot, now);
    const loaded = await loadProviderQuotaSnapshot();
    expect(loaded).not.toBeNull();
    const reloaded = loaded?.providers[providerKey];
    expect(reloaded?.reason).toBe('cooldown');
    expect(reloaded?.inPool).toBe(false);
    expect(reloaded?.cooldownUntil).toBe(now.getTime() + 30_000);
    expect(reloaded?.lastErrorSeries).toBe('EOTHER');
    expect(reloaded?.lastErrorCode).toBe('HTTP_400');
    expect(reloaded?.consecutiveErrorCount).toBe(2);
  });

  it('drops persisted auth-fatal cooldown state so repaired credentials are not blocked after restart', async () => {
    const now = new Date('2026-01-15T10:20:00.000Z');
    const state = createInitialQuotaState(providerKey, { priorityTier: 42, authType: 'apikey' }, now.getTime());
    const snapshot = {
      [providerKey]: {
        ...state,
        inPool: true,
        reason: 'cooldown',
        cooldownUntil: now.getTime() + 5 * 60_000,
        lastErrorSeries: 'EFATAL',
        lastErrorCode: 'NEW_API_ERROR',
        lastErrorAtMs: now.getTime(),
        consecutiveErrorCount: 2
      }
    };

    await saveProviderQuotaSnapshot(snapshot, now);
    const loaded = await loadProviderQuotaSnapshot();
    expect(loaded).not.toBeNull();
    const reloaded = loaded?.providers[providerKey];
    expect(reloaded?.reason).toBe('ok');
    expect(reloaded?.inPool).toBe(true);
    expect(reloaded?.cooldownUntil).toBeNull();
    expect(reloaded?.lastErrorSeries).toBeNull();
    expect(reloaded?.lastErrorCode).toBeNull();
    expect(reloaded?.consecutiveErrorCount).toBe(0);
  });

  it('restores persisted repeated 5xx cooldown to keep provider in pool', async () => {
    const now = new Date('2026-05-23T21:30:00.000Z');
    const state = createInitialQuotaState(providerKey, { priorityTier: 42, authType: 'apikey' }, now.getTime());
    const snapshot = {
      [providerKey]: {
        ...state,
        inPool: false,
        reason: 'cooldown',
        cooldownUntil: now.getTime() + 60_000,
        cooldownKeepsPool: undefined,
        lastErrorSeries: 'E5XX',
        lastErrorCode: 'HTTP_502',
        lastErrorAtMs: now.getTime(),
        consecutiveErrorCount: 4
      }
    };

    await saveProviderQuotaSnapshot(snapshot, now);
    const loaded = await loadProviderQuotaSnapshot();
    expect(loaded).not.toBeNull();
    const reloaded = loaded?.providers[providerKey];
    expect(reloaded?.reason).toBe('cooldown');
    expect(reloaded?.inPool).toBe(true);
    expect(reloaded?.cooldownKeepsPool).toBe(true);
    expect(reloaded?.cooldownUntil).toBe(now.getTime() + 60_000);
    expect(reloaded?.consecutiveErrorCount).toBe(4);
  });

  it('restores persisted generic external cooldown to keep provider in pool', async () => {
    const now = new Date('2026-05-23T21:35:00.000Z');
    const state = createInitialQuotaState(providerKey, { priorityTier: 42, authType: 'apikey' }, now.getTime());
    const snapshot = {
      [providerKey]: {
        ...state,
        inPool: false,
        reason: 'cooldown',
        cooldownUntil: now.getTime() + 60_000,
        cooldownKeepsPool: undefined,
        lastErrorSeries: 'EOTHER',
        lastErrorCode: 'EXTERNAL_ERROR',
        lastErrorAtMs: now.getTime(),
        consecutiveErrorCount: 4
      }
    };

    await saveProviderQuotaSnapshot(snapshot, now);
    const loaded = await loadProviderQuotaSnapshot();
    const reloaded = loaded?.providers[providerKey];
    expect(reloaded?.reason).toBe('cooldown');
    expect(reloaded?.inPool).toBe(true);
    expect(reloaded?.cooldownKeepsPool).toBe(true);
    expect(reloaded?.lastErrorCode).toBe('EXTERNAL_ERROR');
  });

  it('drops stale cooldown snapshots without active cooldownUntil so providers re-enter pool after restart', async () => {
    const now = new Date('2026-01-15T10:40:00.000Z');
    const state = createInitialQuotaState(providerKey, { priorityTier: 42, authType: 'apikey' }, now.getTime());
    const rawPayload = {
      version: 1,
      updatedAt: now.toISOString(),
      providers: {
        [providerKey]: {
          ...state,
          inPool: false,
          reason: 'cooldown',
          cooldownUntil: null,
          blacklistUntil: null,
          lastErrorSeries: 'E5XX',
          lastErrorCode: 'WINDSURF_SERVICE_UNREACHABLE',
          lastErrorAtMs: now.getTime(),
          consecutiveErrorCount: 4
        }
      }
    };

    await fs.writeFile(path.join(quotaDir(), 'provider-quota.json'), `${JSON.stringify(rawPayload, null, 2)}\n`, 'utf8');
    const loaded = await loadProviderQuotaSnapshot();
    const reloaded = loaded?.providers[providerKey];
    expect(reloaded?.inPool).toBe(true);
    expect(reloaded?.reason).toBe('ok');
    expect(reloaded?.cooldownUntil).toBeNull();
    expect(reloaded?.lastErrorCode).toBeNull();
    expect(reloaded?.consecutiveErrorCount).toBe(0);
  });

  it('sanitizes legacy auth-fatal cooldown snapshots on load', async () => {
    const now = new Date('2026-01-15T10:30:00.000Z');
    const state = createInitialQuotaState(providerKey, { priorityTier: 42, authType: 'apikey' }, now.getTime());
    const legacy = sanitizeQuotaStateForSnapshot({
      ...state,
      inPool: true,
      reason: 'cooldown',
      cooldownUntil: now.getTime() + 5 * 60_000,
      lastErrorSeries: 'EOTHER',
      lastErrorCode: 'HTTP_400',
      lastErrorAtMs: now.getTime(),
      consecutiveErrorCount: 2
    });
    expect(legacy.reason).toBe('cooldown');

    const rawPayload = {
      version: 1,
      updatedAt: now.toISOString(),
      providers: {
        [providerKey]: {
          ...state,
          inPool: true,
          reason: 'cooldown',
          cooldownUntil: now.getTime() + 5 * 60_000,
          lastErrorSeries: 'EFATAL',
          lastErrorCode: 'NEW_API_ERROR',
          lastErrorAtMs: now.getTime(),
          consecutiveErrorCount: 2
        }
      }
    };

    await fs.writeFile(path.join(quotaDir(), 'provider-quota.json'), `${JSON.stringify(rawPayload, null, 2)}\n`, 'utf8');
    const loaded = await loadProviderQuotaSnapshot();
    const reloaded = loaded?.providers[providerKey];
    expect(reloaded?.reason).toBe('ok');
    expect(reloaded?.cooldownUntil).toBeNull();
    expect(reloaded?.lastErrorSeries).toBeNull();
    expect(reloaded?.lastErrorCode).toBeNull();
    expect(reloaded?.consecutiveErrorCount).toBe(0);
  });
});

describe('provider-quota-store error event log', () => {
  const originalQuotaDir = process.env.ROUTECODEX_QUOTA_DIR;
  let tempDir: string | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-test-'));
    process.env.ROUTECODEX_QUOTA_DIR = tempDir;
  });

  afterEach(async () => {
    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
    tempDir = null;
    if (originalQuotaDir === undefined) delete process.env.ROUTECODEX_QUOTA_DIR;
    else process.env.ROUTECODEX_QUOTA_DIR = originalQuotaDir;
  });

  it('appends error events as ndjson', async () => {
    const ts = new Date('2026-01-15T10:05:00.000Z').toISOString();
    await appendProviderErrorEvent({
      ts,
      providerKey: 'test.provider.key',
      code: 'HTTP_429',
      httpStatus: 429,
      message: 'Rate limit'
    });
    const filePath = path.join(quotaDir(), 'provider-errors.ndjson');
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as {
      ts: string;
      providerKey: string;
      code?: string;
      httpStatus?: number;
      message?: string;
    };
    expect(parsed.ts).toBe(ts);
    expect(parsed.providerKey).toBe('test.provider.key');
    expect(parsed.code).toBe('HTTP_429');
    expect(parsed.httpStatus).toBe(429);
    expect(parsed.message).toBe('Rate limit');
  });
});
