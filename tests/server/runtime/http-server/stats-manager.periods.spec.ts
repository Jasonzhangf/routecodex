import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StatsManager } from '../../../../src/server/runtime/http-server/stats-manager.js';

describe('StatsManager historical dedupe and periods', () => {
  const originalStatsEnabledEnv = process.env.ROUTECODEX_STATS_ENABLED;
  const originalStatsVerboseEnv = process.env.ROUTECODEX_STATS_VERBOSE;
  const originalStatsLogEnv = process.env.ROUTECODEX_STATS_LOG;
  const originalPersistIntervalEnv = process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-stats-periods-'));
    process.env.ROUTECODEX_STATS_ENABLED = '1';
    process.env.ROUTECODEX_STATS_VERBOSE = '0';
    process.env.ROUTECODEX_STATS_LOG = path.join(tempDir, 'provider-stats.jsonl');
    process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS = '3600000';
  });

  afterEach(async () => {
    if (originalStatsEnabledEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_ENABLED;
    } else {
      process.env.ROUTECODEX_STATS_ENABLED = originalStatsEnabledEnv;
    }
    if (originalStatsVerboseEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_VERBOSE;
    } else {
      process.env.ROUTECODEX_STATS_VERBOSE = originalStatsVerboseEnv;
    }
    if (originalStatsLogEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_LOG;
    } else {
      process.env.ROUTECODEX_STATS_LOG = originalStatsLogEnv;
    }
    if (originalPersistIntervalEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS;
    } else {
      process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS = originalPersistIntervalEnv;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('loads only latest snapshot per session and exposes daily/weekly/monthly buckets', async () => {
    const stats = new StatsManager();

    stats.recordRequestStart('req-1');
    stats.bindProvider('req-1', { providerKey: 'iflow.2-173.kimi-k2.5', model: 'kimi-k2.5' });
    stats.recordCompletion('req-1', {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    const snap1 = stats.snapshot(1000);
    await stats.persistSnapshot(snap1, { reason: 'periodic' });

    stats.recordRequestStart('req-2');
    stats.bindProvider('req-2', { providerKey: 'iflow.2-173.kimi-k2.5', model: 'kimi-k2.5' });
    stats.recordCompletion('req-2', {
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    });
    const snap2 = stats.snapshot(2000);
    await stats.persistSnapshot(snap2, { reason: 'server_shutdown' });

    const reloaded = new StatsManager();
    const historical = reloaded.snapshotHistorical();
    const periods = reloaded.snapshotHistoricalPeriods();

    const reqTotal = historical.totals.reduce((sum, row) => sum + (row.requestCount ?? 0), 0);
    const promptTotal = historical.totals.reduce((sum, row) => sum + (row.totalPromptTokens ?? 0), 0);
    const completionTotal = historical.totals.reduce((sum, row) => sum + (row.totalCompletionTokens ?? 0), 0);

    // Same session persisted twice (seq=1,2): only latest cumulative snapshot should be counted.
    expect(reqTotal).toBe(2);
    expect(promptTotal).toBe(30);
    expect(completionTotal).toBe(15);
    expect(periods.daily.length).toBeGreaterThanOrEqual(1);
    expect(periods.weekly.length).toBeGreaterThanOrEqual(1);
    expect(periods.monthly.length).toBeGreaterThanOrEqual(1);
    expect(periods.daily[0]?.requestCount).toBe(2);
    expect(periods.daily[0]?.totalPromptTokens).toBe(30);
    expect(periods.daily[0]?.totalCompletionTokens).toBe(15);
  });
});
