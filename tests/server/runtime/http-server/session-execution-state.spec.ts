import { describe, expect, it } from '@jest/globals';

import { SessionExecutionStateTracker } from '../../../../src/server/runtime/http-server/session-execution-state.js';

describe('session-execution-state', () => {
  it('treats open SSE as active execution', () => {
    const tracker = new SessionExecutionStateTracker();
    tracker.recordRequestStart('req_stream_1', { tmuxSessionId: 'tmux_a', stream: true });
    tracker.recordSseStreamStart('req_stream_1');

    const snapshot = tracker.getStateSnapshot('tmux_a', { nowMs: Date.now() });
    expect(snapshot.state).toBe('STREAMING_OPEN');
    expect(snapshot.shouldSkipHeartbeat).toBe(true);
    expect(snapshot.reason).toBe('sse_open');
  });

  it('treats latest pending request inside timeout window as waiting_response', () => {
    const tracker = new SessionExecutionStateTracker();
    tracker.recordRequestStart('req_wait_1', { tmuxSessionId: 'tmux_b', stream: false });

    const snapshot = tracker.getStateSnapshot('tmux_b', {
      nowMs: Date.now() + 30_000,
      waitingTimeoutMs: 5 * 60 * 1000
    });
    expect(snapshot.state).toBe('WAITING_RESPONSE');
    expect(snapshot.shouldSkipHeartbeat).toBe(true);
    expect(snapshot.reason).toBe('waiting_response');
  });

  it('treats timed out pending request as staled', () => {
    const tracker = new SessionExecutionStateTracker();
    const nowMs = Date.now();
    tracker.recordRequestStart('req_timeout_1', { tmuxSessionId: 'tmux_c', stream: false });

    const snapshot = tracker.getStateSnapshot('tmux_c', {
      nowMs: nowMs + 6 * 60 * 1000,
      waitingTimeoutMs: 5 * 60 * 1000
    });
    expect(snapshot.state).toBe('STALED');
    expect(snapshot.shouldSkipHeartbeat).toBe(false);
    expect(snapshot.reason).toBe('request_timed_out');
  });

  it('treats recent non-stop response as post response grace', () => {
    const tracker = new SessionExecutionStateTracker();
    const nowMs = Date.now();
    tracker.recordRequestStart('req_tool_1', { tmuxSessionId: 'tmux_d', stream: false });
    tracker.recordJsonResponseComplete('req_tool_1', 'tool_calls');

    const snapshot = tracker.getStateSnapshot('tmux_d', {
      nowMs: nowMs + 10_000,
      postResponseGraceMs: 60_000
    });
    expect(snapshot.state).toBe('POST_RESPONSE_GRACE');
    expect(snapshot.shouldSkipHeartbeat).toBe(true);
    expect(snapshot.reason).toBe('recent_nonterminal_response');
  });

  it('treats stop response as idle', () => {
    const tracker = new SessionExecutionStateTracker();
    tracker.recordRequestStart('req_stop_1', { tmuxSessionId: 'tmux_e', stream: false });
    tracker.recordJsonResponseComplete('req_stop_1', 'stop');

    const snapshot = tracker.getStateSnapshot('tmux_e');
    expect(snapshot.state).toBe('IDLE');
    expect(snapshot.shouldSkipHeartbeat).toBe(false);
    expect(snapshot.reason).toBe('latest_response_stop');
  });

  it('treats SSE client close before terminal as staled', () => {
    const tracker = new SessionExecutionStateTracker();
    tracker.recordRequestStart('req_close_1', { tmuxSessionId: 'tmux_f', stream: true });
    tracker.recordSseStreamStart('req_close_1');
    tracker.recordSseClientClose('req_close_1', { closeBeforeStreamEnd: true, terminal: false });

    const snapshot = tracker.getStateSnapshot('tmux_f');
    expect(snapshot.state).toBe('STALED');
    expect(snapshot.shouldSkipHeartbeat).toBe(false);
    expect(snapshot.reason).toBe('client_closed_before_terminal');
  });
});
