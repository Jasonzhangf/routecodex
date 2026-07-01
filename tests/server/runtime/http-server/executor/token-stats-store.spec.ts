import { jest } from '@jest/globals';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import fsRead from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourcePath = path.resolve(
  __dirname,
  '../../../../../src/server/runtime/http-server/executor/token-stats-store.ts'
);

describe('token stats store', () => {
  const originalEnv = { ...process.env };
  const tempHomes = new Set<string>();

  afterEach(async () => {
    try {
      const { __resetTokenStatsForTest } = await import('../../../../../src/server/runtime/http-server/executor/token-stats-store.js');
      __resetTokenStatsForTest();
    } catch {
      // ignore cleanup failure during module reset
    }
    for (const home of tempHomes) {
      await fs.rm(home, { recursive: true, force: true });
    }
    tempHomes.clear();
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  function allocateFakeHome(label: string): string {
    const fakeHome = path.join(os.tmpdir(), `${label}-${process.pid}-${randomUUID()}`);
    tempHomes.add(fakeHome);
    jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    return fakeHome;
  }

  it('does not keep legacy v1 persisted snapshot handling', () => {
    const source = fsRead.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('legacy-v1');
    expect(source).not.toContain('Legacy v1');
    expect(source).not.toContain('buildLegacySnapshotForTests');
    expect(source).not.toContain('__dumpPersistedTokenStatsForTest');
  });

  it('updates memory immediately and avoids hot-path sync writes', async () => {
    const fakeHome = allocateFakeHome('token-stats-memory');
    const writeFileSyncSpy = jest.spyOn(fsSync, 'writeFileSync');
    const {
      recordTokens,
      getTokenTotals,
      getTokenStatsSnapshot
    } = await import('../../../../../src/server/runtime/http-server/executor/token-stats-store.js');

    recordTokens('provider.a', 'model.a', 10, 5, 15);

    expect(getTokenTotals()).toEqual({ alltimeTokens: 15, dailyTokens: 15 });
    expect(getTokenStatsSnapshot().providers).toEqual([
      expect.objectContaining({
        providerKey: 'provider.a',
        model: 'model.a',
        totalTokens: 15
      })
    ]);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    await expect(fs.access(path.join(fakeHome, '.rcc', 'token-stats.json'))).rejects.toThrow();
  });

  it('flushes current snapshot to disk with atomic full payload', async () => {
    const fakeHome = allocateFakeHome('token-stats-flush');
    const statsPath = path.join(fakeHome, '.rcc', 'token-stats.json');
    const { recordTokens, flushTokenStats } = await import(
      '../../../../../src/server/runtime/http-server/executor/token-stats-store.js'
    );

    recordTokens('provider.a', 'model.a', 10, 5, 15);
    recordTokens('provider.b', 'model.b', 4, 6, 10);
    flushTokenStats();

    const persisted = JSON.parse(await fs.readFile(statsPath, 'utf8'));
    expect(persisted.version).toBe(2);
    const sessions = Object.values(persisted.sessions ?? {}) as Array<{
      alltime: Record<string, unknown>;
      providers: Record<string, Record<string, unknown>>;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].alltime).toEqual({
      promptTokens: 14,
      completionTokens: 11,
      totalTokens: 25,
      cacheReadTokens: 0
    });
    expect(sessions[0].providers?.['provider.a|model.a']).toMatchObject({
      providerKey: 'provider.a',
      model: 'model.a',
      totalTokens: 15
    });
    expect(sessions[0].providers?.['provider.b|model.b']).toMatchObject({
      providerKey: 'provider.b',
      model: 'model.b',
      totalTokens: 10
    });
  });

  it('loads persisted stats and keeps provider snapshot sorted by total tokens', async () => {
    const fakeHome = allocateFakeHome('token-stats-load');
    const statsPath = path.join(fakeHome, '.rcc', 'token-stats.json');
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await fs.mkdir(path.dirname(statsPath), { recursive: true });
    await fs.writeFile(
      statsPath,
      `${JSON.stringify({
        version: 2,
        sessions: {
          'foreign-session': {
            sessionId: 'foreign-session',
            updatedAt: 1,
            alltime: {
              promptTokens: 30,
              completionTokens: 12,
              totalTokens: 42
            },
            daily: {
              [todayKey]: {
                promptTokens: 7,
                completionTokens: 5,
                totalTokens: 12
              }
            },
            providers: {
              'provider.small|model.s': {
                providerKey: 'provider.small',
                model: 'model.s',
                promptTokens: 2,
                completionTokens: 3,
                totalTokens: 5
              },
              'provider.big|model.b': {
                providerKey: 'provider.big',
                model: 'model.b',
                promptTokens: 10,
                completionTokens: 10,
                totalTokens: 20
              }
            }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    const { getTokenTotals, getTokenStatsSnapshot } = await import(
      '../../../../../src/server/runtime/http-server/executor/token-stats-store.js'
    );

    expect(getTokenTotals()).toEqual({ alltimeTokens: 42, dailyTokens: 12 });
    expect(getTokenStatsSnapshot().providers.map((entry) => entry.providerKey)).toEqual([
      'provider.big',
      'provider.small'
    ]);
  });
});
