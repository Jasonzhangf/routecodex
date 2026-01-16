import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendProviderErrorEvent,
  loadProviderQuotaSnapshot,
  saveProviderQuotaSnapshot
} from '../../../src/manager/quota/provider-quota-store.js';
import { createInitialQuotaState } from '../../../src/manager/quota/provider-quota-center.js';

function quotaDir(): string {
  const home = os.homedir();
  return path.join(home, '.routecodex', 'quota');
}

describe('provider-quota-store snapshot', () => {
  const providerKey = 'test.provider.key';

  afterEach(async () => {
    const dir = quotaDir();
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
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
});

describe('provider-quota-store error event log', () => {
  afterEach(async () => {
    const dir = quotaDir();
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
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
