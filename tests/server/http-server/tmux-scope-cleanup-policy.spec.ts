import {
  evaluateTmuxScopeCleanup,
  probeTmuxScopeLiveness
} from '../../../src/server/runtime/http-server/tmux-scope-cleanup-policy.js';

describe('tmux scope cleanup policy', () => {
  test('stale record does not clean tmux scope when tmux is still alive', () => {
    const decision = evaluateTmuxScopeCleanup({
      mode: 'stale_record',
      tmuxSessionId: 'rcc_alive_tmux',
      reason: 'stale_heartbeat',
      isTmuxSessionAlive: () => true
    });
    expect(decision.cleanupTmuxScope).toBe(false);
    expect(decision.liveness).toBe('alive');
  });

  test('stale record cleans tmux scope only when tmux is confirmed dead', () => {
    const decision = evaluateTmuxScopeCleanup({
      mode: 'stale_record',
      tmuxSessionId: 'rcc_dead_tmux',
      reason: 'stale_heartbeat',
      isTmuxSessionAlive: () => false
    });
    expect(decision.cleanupTmuxScope).toBe(true);
    expect(decision.liveness).toBe('dead');
  });

  test('runtime failure does not clean tmux scope on inject failure when tmux is still alive', () => {
    const decision = evaluateTmuxScopeCleanup({
      mode: 'runtime_failure',
      tmuxSessionId: 'rcc_inject_alive',
      reason: 'tmux_send_failed_timeout',
      isTmuxSessionAlive: () => true
    });
    expect(decision.cleanupTmuxScope).toBe(false);
    expect(decision.liveness).toBe('alive');
  });

  test('probe returns unknown when tmux liveness probe is unavailable', () => {
    const probe = probeTmuxScopeLiveness({
      tmuxSessionId: 'rcc_unknown'
    });
    expect(probe.liveness).toBe('unknown');
  });
});
