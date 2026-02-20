import {
  shouldLogClockDaemonCleanupAudit,
  shouldClearClockTasksForInjectSkip,
  shouldLogClockDaemonInjectSkip
} from '../../../src/server/runtime/http-server/clock-daemon-log-throttle.js';

describe('clock daemon inject skip log throttle', () => {
  test('deduplicates repeated benign skips by session+reason with long cooldown', () => {
    const cache = new Map<string, number>();
    const input = {
      sessionId: 'sess_a',
      injectReason: 'no_matching_tmux_session_daemon',
      bindReason: 'no_binding_candidate'
    };
    const now = 1_000;

    expect(shouldLogClockDaemonInjectSkip({ cache, input, nowMs: now })).toBe(true);
    expect(shouldLogClockDaemonInjectSkip({ cache, input, nowMs: now + 5_000 })).toBe(false);
    expect(shouldLogClockDaemonInjectSkip({ cache, input, nowMs: now + 9 * 60_000 })).toBe(false);
    expect(shouldLogClockDaemonInjectSkip({ cache, input, nowMs: now + 10 * 60_000 + 1 })).toBe(true);
  });

  test('keeps different sessions/reasons independent', () => {
    const cache = new Map<string, number>();
    const now = 2_000;

    expect(
      shouldLogClockDaemonInjectSkip({
        cache,
        input: { sessionId: 'sess_a', injectReason: 'no_matching_tmux_session_daemon', bindReason: 'no_binding_candidate' },
        nowMs: now
      })
    ).toBe(true);

    expect(
      shouldLogClockDaemonInjectSkip({
        cache,
        input: { sessionId: 'sess_b', injectReason: 'no_matching_tmux_session_daemon', bindReason: 'no_binding_candidate' },
        nowMs: now + 100
      })
    ).toBe(true);

    expect(
      shouldLogClockDaemonInjectSkip({
        cache,
        input: { sessionId: 'sess_a', injectReason: 'inject_failed', bindReason: 'bind_ok' },
        nowMs: now + 200
      })
    ).toBe(true);
  });

  test('marks no-matching-tmux + no-binding as orphan clock session to clear', () => {
    expect(
      shouldClearClockTasksForInjectSkip({
        sessionId: 'sess_orphan',
        injectReason: 'no_matching_tmux_session_daemon',
        bindReason: 'no_binding_candidate'
      })
    ).toBe(true);
    expect(
      shouldClearClockTasksForInjectSkip({
        sessionId: 'sess_ok',
        injectReason: 'inject_failed',
        bindReason: 'bind_ok'
      })
    ).toBe(false);
  });

  test('deduplicates repeated cleanup audit logs with same signature', () => {
    const cache = new Map<string, number>();
    const input = {
      managedTerminationEnabled: false,
      staleRemovedDaemonIds: ['clockd_a'],
      staleRemovedTmuxSessionIds: [],
      deadRemovedDaemonIds: ['clockd_b'],
      deadRemovedTmuxSessionIds: ['rcc_dead_1'],
      failedKillTmuxSessionIds: [],
      failedKillManagedClientPids: []
    };

    expect(shouldLogClockDaemonCleanupAudit({ cache, input, nowMs: 1000 })).toBe(true);
    expect(shouldLogClockDaemonCleanupAudit({ cache, input, nowMs: 1000 + 5_000 })).toBe(false);
    expect(shouldLogClockDaemonCleanupAudit({ cache, input, nowMs: 1000 + 10 * 60_000 + 1 })).toBe(true);
  });

  test('cleanup audit cache key is order-insensitive for ids', () => {
    const cache = new Map<string, number>();
    const base = {
      managedTerminationEnabled: true,
      staleRemovedDaemonIds: ['clockd_a', 'clockd_b'],
      staleRemovedTmuxSessionIds: ['rcc_1'],
      deadRemovedDaemonIds: ['clockd_c'],
      deadRemovedTmuxSessionIds: ['rcc_2', 'rcc_3'],
      failedKillTmuxSessionIds: ['rcc_9'],
      failedKillManagedClientPids: [12345]
    };

    expect(shouldLogClockDaemonCleanupAudit({ cache, input: base, nowMs: 2000 })).toBe(true);
    expect(
      shouldLogClockDaemonCleanupAudit({
        cache,
        input: {
          ...base,
          staleRemovedDaemonIds: ['clockd_b', 'clockd_a'],
          deadRemovedTmuxSessionIds: ['rcc_3', 'rcc_2']
        },
        nowMs: 2000 + 100
      })
    ).toBe(false);
  });
});
