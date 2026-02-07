import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

type BuildMode = 'dev' | 'release';

describe('StatsManager release behavior', () => {
  const originalStatsEnabledEnv = process.env.ROUTECODEX_STATS_ENABLED;
  const originalStatsVerboseEnv = process.env.ROUTECODEX_STATS_VERBOSE;
  const originalStatsLogEnv = process.env.ROUTECODEX_STATS_LOG;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
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
  });

  async function importStatsManagerWithMode(mode: BuildMode) {
    jest.unstable_mockModule('../../../../src/build-info.js', () => ({
      buildInfo: {
        mode,
        version: 'test',
        buildTime: '2026-02-07T00:00:00.000Z'
      }
    }));
    const mod = await import('../../../../src/server/runtime/http-server/stats-manager.js');
    return mod.StatsManager;
  }

  it('does not record or persist stats in release by default', async () => {
    delete process.env.ROUTECODEX_STATS_ENABLED;
    delete process.env.ROUTECODEX_STATS_VERBOSE;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-stats-release-default-'));
    const logPath = path.join(tempDir, 'provider-stats.jsonl');
    process.env.ROUTECODEX_STATS_LOG = logPath;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const StatsManager = await importStatsManagerWithMode('release');
    const stats = new StatsManager();

    stats.recordRequestStart('req-release-default');
    stats.bindProvider('req-release-default', { providerKey: 'demo.provider', model: 'demo-model' });
    stats.recordCompletion('req-release-default', {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    const snapshot = stats.logSummary(1234);
    await stats.persistSnapshot(snapshot, { reason: 'unit-test' });
    await stats.logHistoricalSummary();

    expect(snapshot.totals).toHaveLength(0);
    await expect(fs.access(logPath)).rejects.toBeDefined();
    expect(logSpy).not.toHaveBeenCalled();

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('records and persists stats in release when explicitly enabled', async () => {
    process.env.ROUTECODEX_STATS_ENABLED = '1';
    process.env.ROUTECODEX_STATS_VERBOSE = '0';

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-stats-release-enabled-'));
    const logPath = path.join(tempDir, 'provider-stats.jsonl');
    process.env.ROUTECODEX_STATS_LOG = logPath;

    const StatsManager = await importStatsManagerWithMode('release');
    const stats = new StatsManager();

    stats.recordRequestStart('req-release-enabled');
    stats.bindProvider('req-release-enabled', { providerKey: 'demo.provider', model: 'demo-model' });
    stats.recordCompletion('req-release-enabled', {
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
    });

    const snapshot = stats.logSummary(888);
    await stats.persistSnapshot(snapshot, { reason: 'unit-test' });

    expect(snapshot.totals).toHaveLength(1);
    const content = await fs.readFile(logPath, 'utf8');
    expect(content).toContain('demo.provider');

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
