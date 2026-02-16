import { ClockClientRegistry } from '../../../src/server/runtime/http-server/clock-client-registry.js';

describe('ClockClientRegistry cleanup', () => {
  it('stale heartbeat cleanup removes record but never kills tmux session', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_managed_1',
      callbackUrl: 'http://127.0.0.1:65530/inject',
      tmuxSessionId: 'rcc_codex_1',
      managedTmuxSession: true
    });

    const killed: string[] = [];
    const cleanup = registry.cleanupStaleHeartbeats({
      nowMs: Date.now() + 60_000,
      staleAfterMs: 1,
      terminateManagedTmuxSession: (tmuxSessionId) => {
        killed.push(tmuxSessionId);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_managed_1']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.failedKillTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_codex_1']);
    expect(killed).toEqual([]);
  });

  it('does not kill stale tmux session when not explicitly managed', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_unmanaged_1',
      callbackUrl: 'http://127.0.0.1:65531/inject',
      tmuxSessionId: 'rcc_user_custom_1'
    });

    const killed: string[] = [];
    const cleanup = registry.cleanupStaleHeartbeats({
      nowMs: Date.now() + 60_000,
      staleAfterMs: 1,
      terminateManagedTmuxSession: (tmuxSessionId) => {
        killed.push(tmuxSessionId);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_unmanaged_1']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_user_custom_1']);
    expect(killed).toEqual([]);
  });

  it('does not kill shared tmux session when another daemon is alive', () => {
    const registry = new ClockClientRegistry();

    registry.register({
      daemonId: 'clockd_stale_shared',
      callbackUrl: 'http://127.0.0.1:65532/inject',
      tmuxSessionId: 'rcc_shared_tmux',
      managedTmuxSession: true
    });
    registry.register({
      daemonId: 'clockd_live_shared',
      callbackUrl: 'http://127.0.0.1:65533/inject',
      tmuxSessionId: 'rcc_shared_tmux',
      managedTmuxSession: true
    });

    const registryInternal = registry as unknown as {
      records: Map<string, { lastHeartbeatAtMs: number }>;
    };

    const staleRecord = registryInternal.records.get('clockd_stale_shared');
    const liveRecord = registryInternal.records.get('clockd_live_shared');
    expect(staleRecord).toBeDefined();
    expect(liveRecord).toBeDefined();
    if (staleRecord) {
      staleRecord.lastHeartbeatAtMs = 0;
    }
    if (liveRecord) {
      liveRecord.lastHeartbeatAtMs = Date.now();
    }

    const killed: string[] = [];
    const cleanup = registry.cleanupStaleHeartbeats({
      nowMs: Date.now() + 500,
      staleAfterMs: 1_000,
      terminateManagedTmuxSession: (tmuxSessionId) => {
        killed.push(tmuxSessionId);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_stale_shared']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_shared_tmux']);
    expect(killed).toEqual([]);

    const remaining = registry.list().map((item) => item.daemonId);
    expect(remaining).toContain('clockd_live_shared');
    expect(remaining).not.toContain('clockd_stale_shared');
  });

  it('stale heartbeat cleanup removes record but never kills managed child pid', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_managed_child_1',
      callbackUrl: 'http://127.0.0.1:65540/inject',
      managedClientProcess: true,
      managedClientPid: 43210,
      managedClientCommandHint: 'codex',
      clientType: 'codex'
    });

    const killedPids: number[] = [];
    const cleanup = registry.cleanupStaleHeartbeats({
      nowMs: Date.now() + 60_000,
      staleAfterMs: 1,
      terminateManagedClientProcess: ({ pid }) => {
        killedPids.push(pid);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_managed_child_1']);
    expect(cleanup.killedManagedClientPids).toEqual([]);
    expect(cleanup.failedKillManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillManagedClientPids).toEqual([43210]);
    expect(killedPids).toEqual([]);
  });

  it('skips unmanaged child pid during stale cleanup', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_unmanaged_child_1',
      callbackUrl: 'http://127.0.0.1:65541/inject',
      managedClientPid: 54321,
      managedClientCommandHint: 'codex',
      clientType: 'codex'
    });

    const killedPids: number[] = [];
    const cleanup = registry.cleanupStaleHeartbeats({
      nowMs: Date.now() + 60_000,
      staleAfterMs: 1,
      terminateManagedClientProcess: ({ pid }) => {
        killedPids.push(pid);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_unmanaged_child_1']);
    expect(cleanup.killedManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillManagedClientPids).toEqual([54321]);
    expect(killedPids).toEqual([]);
  });

  it('dead tmux cleanup attempts terminate for managed sessions and child process', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_dead_managed',
      callbackUrl: 'http://127.0.0.1:65534/inject',
      tmuxSessionId: 'rcc_dead_managed',
      managedTmuxSession: true,
      managedClientProcess: true,
      managedClientPid: 24680,
      managedClientCommandHint: 'claude',
      clientType: 'claude'
    });

    const killedTmux: string[] = [];
    const killedPids: number[] = [];
    const cleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive: () => false,
      terminateManagedTmuxSession: (tmuxSessionId) => {
        killedTmux.push(tmuxSessionId);
        return true;
      },
      terminateManagedClientProcess: ({ pid }) => {
        killedPids.push(pid);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_dead_managed']);
    expect(cleanup.killedTmuxSessionIds).toEqual(['rcc_dead_managed']);
    expect(cleanup.killedManagedClientPids).toEqual([24680]);
    expect(cleanup.failedKillTmuxSessionIds).toEqual([]);
    expect(cleanup.failedKillManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillManagedClientPids).toEqual([]);
    expect(killedTmux).toEqual(['rcc_dead_managed']);
    expect(killedPids).toEqual([24680]);
  });

  it('dead tmux cleanup removes mapped conversation sessions even when record list drifts', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_dead_mapping',
      callbackUrl: 'http://127.0.0.1:65538/inject',
      tmuxSessionId: 'rcc_dead_mapping',
      managedTmuxSession: true
    });

    const bindResult = registry.bindConversationSession({
      conversationSessionId: 'conv_dead_mapping',
      tmuxSessionId: 'rcc_dead_mapping'
    });
    expect(bindResult.ok).toBe(true);

    const internal = registry as unknown as {
      records: Map<string, { conversationSessionIds?: string[] }>;
    };
    const record = internal.records.get('clockd_dead_mapping');
    expect(record).toBeDefined();
    if (record) {
      record.conversationSessionIds = [];
    }

    const cleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive: () => false,
      terminateManagedTmuxSession: () => true
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_dead_mapping']);
    expect(cleanup.removedTmuxSessionIds).toEqual(['rcc_dead_mapping']);
    expect(cleanup.removedConversationSessionIds).toContain('conv_dead_mapping');

    const unbound = registry.unbindConversationSession('conv_dead_mapping');
    expect(unbound.ok).toBe(true);
    expect(unbound.removed).toBe(false);
  });

  it('stale cleanup ignores terminate failures and still removes managed record', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_stale_managed_fail',
      callbackUrl: 'http://127.0.0.1:65536/inject',
      tmuxSessionId: 'rcc_stale_managed_fail',
      managedTmuxSession: true,
      managedClientProcess: true,
      managedClientPid: 55667,
      managedClientCommandHint: 'codex',
      clientType: 'codex'
    });

    const cleanup = registry.cleanupStaleHeartbeats({
      nowMs: Date.now() + 60_000,
      staleAfterMs: 1,
      terminateManagedTmuxSession: () => false,
      terminateManagedClientProcess: () => false
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_stale_managed_fail']);
    expect(cleanup.removedTmuxSessionIds).toEqual(['rcc_stale_managed_fail']);
    expect(cleanup.failedKillTmuxSessionIds).toEqual([]);
    expect(cleanup.failedKillManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_stale_managed_fail']);
    expect(cleanup.skippedKillManagedClientPids).toEqual([55667]);
    const alive = registry.list().map((item) => item.daemonId);
    expect(alive).not.toContain('clockd_stale_managed_fail');
  });

  it('keeps dead tmux managed record when terminate fails', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_dead_managed_fail',
      callbackUrl: 'http://127.0.0.1:65537/inject',
      tmuxSessionId: 'rcc_dead_managed_fail',
      managedTmuxSession: true,
      managedClientProcess: true,
      managedClientPid: 66778,
      managedClientCommandHint: 'claude',
      clientType: 'claude'
    });

    const cleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive: () => false,
      terminateManagedTmuxSession: () => false,
      terminateManagedClientProcess: () => false
    });

    expect(cleanup.removedDaemonIds).toEqual([]);
    expect(cleanup.removedTmuxSessionIds).toEqual([]);
    expect(cleanup.failedKillTmuxSessionIds).toEqual(['rcc_dead_managed_fail']);
    expect(cleanup.failedKillManagedClientPids).toEqual([66778]);
    const alive = registry.list().map((item) => item.daemonId);
    expect(alive).toContain('clockd_dead_managed_fail');
  });

  it('dead tmux cleanup skips terminate for unmanaged sessions', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_dead_unmanaged',
      callbackUrl: 'http://127.0.0.1:65535/inject',
      tmuxSessionId: 'rcc_dead_unmanaged'
    });

    const killed: string[] = [];
    const cleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive: () => false,
      terminateManagedTmuxSession: (tmuxSessionId) => {
        killed.push(tmuxSessionId);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual(['clockd_dead_unmanaged']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_dead_unmanaged']);
    expect(killed).toEqual([]);
  });

  it('bindConversationSession enforces workdir-scoped candidate selection', () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_workdir_a',
      callbackUrl: 'http://127.0.0.1:65550/inject',
      tmuxSessionId: 'rcc_workdir_a',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-a'
    });
    registry.register({
      daemonId: 'clockd_workdir_b',
      callbackUrl: 'http://127.0.0.1:65551/inject',
      tmuxSessionId: 'rcc_workdir_b',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-b'
    });

    const bindA = registry.bindConversationSession({
      conversationSessionId: 'conv_workdir_a',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-a'
    });
    expect(bindA.ok).toBe(true);
    expect(bindA.daemonId).toBe('clockd_workdir_a');

    const bindMissing = registry.bindConversationSession({
      conversationSessionId: 'conv_workdir_missing',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-missing'
    });
    expect(bindMissing.ok).toBe(false);
    expect(bindMissing.reason).toBe('no_binding_candidate_for_workdir');
  });

  it('inject enforces workdir when tmux session is shared', async () => {
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_shared_tmux_a',
      callbackUrl: 'http://127.0.0.1:65552/inject',
      tmuxSessionId: 'rcc_shared_tmux_workdir',
      workdir: '/tmp/routecodex-shared-workdir-a'
    });
    registry.register({
      daemonId: 'clockd_shared_tmux_b',
      callbackUrl: 'http://127.0.0.1:65553/inject',
      tmuxSessionId: 'rcc_shared_tmux_workdir',
      workdir: '/tmp/routecodex-shared-workdir-b'
    });

    const originalFetch = global.fetch;
    const hits: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      hits.push(String(input));
      return {
        ok: true,
        status: 200,
        text: async () => ''
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const injectA = await registry.inject({
        tmuxSessionId: 'rcc_shared_tmux_workdir',
        workdir: '/tmp/routecodex-shared-workdir-a',
        text: 'hello-a'
      });
      expect(injectA.ok).toBe(true);
      expect(injectA.daemonId).toBe('clockd_shared_tmux_a');

      const injectB = await registry.inject({
        tmuxSessionId: 'rcc_shared_tmux_workdir',
        workdir: '/tmp/routecodex-shared-workdir-b',
        text: 'hello-b'
      });
      expect(injectB.ok).toBe(true);
      expect(injectB.daemonId).toBe('clockd_shared_tmux_b');

      const mismatch = await registry.inject({
        tmuxSessionId: 'rcc_shared_tmux_workdir',
        workdir: '/tmp/routecodex-shared-workdir-c',
        text: 'hello-c'
      });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.reason).toBe('workdir_mismatch');
      expect(hits).toEqual([
        'http://127.0.0.1:65552/inject',
        'http://127.0.0.1:65553/inject'
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
