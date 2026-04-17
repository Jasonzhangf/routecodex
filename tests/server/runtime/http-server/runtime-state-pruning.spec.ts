import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { StatsManager } from '../../../../src/server/runtime/http-server/stats-manager.js';
import { RequestActivityTracker } from '../../../../src/server/runtime/http-server/request-activity-tracker.js';

describe('runtime state pruning', () => {
  const originalStatsEnabledEnv = process.env.ROUTECODEX_STATS_ENABLED;
  const originalStatsVerboseEnv = process.env.ROUTECODEX_STATS_VERBOSE;
  const originalStatsLogEnv = process.env.ROUTECODEX_STATS_LOG;
  const originalStatsPersistIntervalEnv = process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS;
  const originalStatsInflightTtlEnv = process.env.ROUTECODEX_STATS_INFLIGHT_TTL_MS;
  const originalStatsInflightMaxEnv = process.env.ROUTECODEX_STATS_INFLIGHT_MAX_ENTRIES;
  const originalRequestActivityTtlEnv = process.env.ROUTECODEX_REQUEST_ACTIVITY_TTL_MS;
  const originalRequestActivityMaxEnv = process.env.ROUTECODEX_REQUEST_ACTIVITY_MAX_ENTRIES;
  let tempDir = '';

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-15T10:00:00.000Z'));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-runtime-state-'));
    process.env.ROUTECODEX_STATS_ENABLED = '1';
    process.env.ROUTECODEX_STATS_VERBOSE = '0';
    process.env.ROUTECODEX_STATS_LOG = path.join(tempDir, 'provider-stats.jsonl');
    process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS = '3600000';
    await fs.writeFile(process.env.ROUTECODEX_STATS_LOG, '', 'utf8');
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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
    if (originalStatsPersistIntervalEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS;
    } else {
      process.env.ROUTECODEX_STATS_PERSIST_INTERVAL_MS = originalStatsPersistIntervalEnv;
    }
    if (originalStatsInflightTtlEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_INFLIGHT_TTL_MS;
    } else {
      process.env.ROUTECODEX_STATS_INFLIGHT_TTL_MS = originalStatsInflightTtlEnv;
    }
    if (originalStatsInflightMaxEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_INFLIGHT_MAX_ENTRIES;
    } else {
      process.env.ROUTECODEX_STATS_INFLIGHT_MAX_ENTRIES = originalStatsInflightMaxEnv;
    }
    if (originalRequestActivityTtlEnv === undefined) {
      delete process.env.ROUTECODEX_REQUEST_ACTIVITY_TTL_MS;
    } else {
      process.env.ROUTECODEX_REQUEST_ACTIVITY_TTL_MS = originalRequestActivityTtlEnv;
    }
    if (originalRequestActivityMaxEnv === undefined) {
      delete process.env.ROUTECODEX_REQUEST_ACTIVITY_MAX_ENTRIES;
    } else {
      process.env.ROUTECODEX_REQUEST_ACTIVITY_MAX_ENTRIES = originalRequestActivityMaxEnv;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('prunes stale inflight stats records before adding new requests', () => {
    process.env.ROUTECODEX_STATS_INFLIGHT_TTL_MS = '1000';
    process.env.ROUTECODEX_STATS_INFLIGHT_MAX_ENTRIES = '10';
    const stats = new StatsManager();

    stats.recordRequestStart('req-old');
    stats.bindProvider('req-old', { providerKey: 'demo.old', model: 'old-model' });

    jest.advanceTimersByTime(1500);
    stats.recordRequestStart('req-new');

    const inflight = (stats as any).inflight as Map<string, unknown>;
    expect(inflight.has('req-old')).toBe(false);
    expect(inflight.has('req-new')).toBe(true);
  });

  it('caps inflight stats records by oldest start time', () => {
    process.env.ROUTECODEX_STATS_INFLIGHT_TTL_MS = '600000';
    process.env.ROUTECODEX_STATS_INFLIGHT_MAX_ENTRIES = '2';
    const stats = new StatsManager();

    stats.recordRequestStart('req-1');
    jest.advanceTimersByTime(10);
    stats.recordRequestStart('req-2');
    jest.advanceTimersByTime(10);
    stats.recordRequestStart('req-3');

    const inflight = (stats as any).inflight as Map<string, unknown>;
    expect(Array.from(inflight.keys())).toEqual(['req-2', 'req-3']);
  });

  it('prunes stale request activity and releases tmux counts', () => {
    process.env.ROUTECODEX_REQUEST_ACTIVITY_TTL_MS = '1000';
    process.env.ROUTECODEX_REQUEST_ACTIVITY_MAX_ENTRIES = '10';
    const tracker = new RequestActivityTracker();

    tracker.start('req-old', { tmuxSessionId: 'tmux-old' });
    expect(tracker.countActiveRequestsForTmuxSession('tmux-old')).toBe(1);

    jest.advanceTimersByTime(1500);
    tracker.start('req-new', { tmuxSessionId: 'tmux-new' });

    const byRequestId = (tracker as any).byRequestId as Map<string, unknown>;
    expect(byRequestId.has('req-old')).toBe(false);
    expect(tracker.countActiveRequestsForTmuxSession('tmux-old')).toBe(0);
    expect(tracker.countActiveRequestsForTmuxSession('tmux-new')).toBe(1);
  });

  it('caps request activity records and decrements pruned tmux counters', () => {
    process.env.ROUTECODEX_REQUEST_ACTIVITY_TTL_MS = '600000';
    process.env.ROUTECODEX_REQUEST_ACTIVITY_MAX_ENTRIES = '2';
    const tracker = new RequestActivityTracker();

    tracker.start('req-1', { tmuxSessionId: 'tmux-1' });
    jest.advanceTimersByTime(10);
    tracker.start('req-2', { tmuxSessionId: 'tmux-2' });
    jest.advanceTimersByTime(10);
    tracker.start('req-3', { tmuxSessionId: 'tmux-3' });

    const byRequestId = (tracker as any).byRequestId as Map<string, unknown>;
    expect(Array.from(byRequestId.keys())).toEqual(['req-2', 'req-3']);
    expect(tracker.countActiveRequestsForTmuxSession('tmux-1')).toBe(0);
    expect(tracker.countActiveRequestsForTmuxSession('tmux-2')).toBe(1);
    expect(tracker.countActiveRequestsForTmuxSession('tmux-3')).toBe(1);
  });
});
