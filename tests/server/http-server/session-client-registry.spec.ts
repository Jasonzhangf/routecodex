import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionClientRegistry } from '../../../src/server/runtime/http-server/session-client-registry.js';

describe('SessionClientRegistry cleanup', () => {
  it('stale heartbeat cleanup removes record but never kills tmux session', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_managed_1',
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_managed_1']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.failedKillTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_codex_1']);
    expect(killed).toEqual([]);
  });

  it('does not kill stale tmux session when not explicitly managed', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_unmanaged_1',
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_unmanaged_1']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_user_custom_1']);
    expect(killed).toEqual([]);
  });

  it('does not kill shared tmux session when another daemon is alive', () => {
    const registry = new SessionClientRegistry();

    registry.register({
      daemonId: 'sessiond_stale_shared',
      callbackUrl: 'http://127.0.0.1:65532/inject',
      tmuxSessionId: 'rcc_shared_tmux',
      managedTmuxSession: true
    });
    registry.register({
      daemonId: 'sessiond_live_shared',
      callbackUrl: 'http://127.0.0.1:65533/inject',
      tmuxSessionId: 'rcc_shared_tmux',
      managedTmuxSession: true
    });

    const registryInternal = registry as unknown as {
      records: Map<string, { lastHeartbeatAtMs: number }>;
    };

    const staleRecord = registryInternal.records.get('sessiond_stale_shared');
    const liveRecord = registryInternal.records.get('sessiond_live_shared');
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_stale_shared']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_shared_tmux']);
    expect(killed).toEqual([]);

    const remaining = registry.list().map((item) => item.daemonId);
    expect(remaining).toContain('sessiond_live_shared');
    expect(remaining).not.toContain('sessiond_stale_shared');
  });

  it('keeps conversation->tmux mapping when only one of shared tmux daemon records is stale', async () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_stale_shared_mapping',
      callbackUrl: 'http://127.0.0.1:65532/inject',
      tmuxSessionId: 'rcc_shared_tmux_mapping',
      managedTmuxSession: true
    });
    registry.register({
      daemonId: 'sessiond_live_shared_mapping',
      callbackUrl: 'http://127.0.0.1:65533/inject',
      tmuxSessionId: 'rcc_shared_tmux_mapping',
      managedTmuxSession: true
    });
    registry.bindConversationSession({
      conversationSessionId: 'conv_shared_mapping',
      daemonId: 'sessiond_live_shared_mapping'
    });

    const registryInternal = registry as unknown as {
      records: Map<string, { lastHeartbeatAtMs: number }>;
    };
    const staleRecord = registryInternal.records.get('sessiond_stale_shared_mapping');
    const liveRecord = registryInternal.records.get('sessiond_live_shared_mapping');
    expect(staleRecord).toBeDefined();
    expect(liveRecord).toBeDefined();
    if (staleRecord) {
      staleRecord.lastHeartbeatAtMs = 0;
    }
    if (liveRecord) {
      liveRecord.lastHeartbeatAtMs = Date.now();
    }

    const cleanup = registry.cleanupStaleHeartbeats({
      nowMs: Date.now() + 500,
      staleAfterMs: 1_000
    });
    expect(cleanup.removedDaemonIds).toEqual(['sessiond_stale_shared_mapping']);

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
      const injected = await registry.inject({
        sessionId: 'conv_shared_mapping',
        text: 'shared tmux mapping still alive'
      });
      expect(injected.ok).toBe(true);
      expect(injected.daemonId).toBe('sessiond_live_shared_mapping');
      expect(hits).toEqual(['http://127.0.0.1:65533/inject']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('stale heartbeat cleanup removes record but never kills managed child pid', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_managed_child_1',
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_managed_child_1']);
    expect(cleanup.killedManagedClientPids).toEqual([]);
    expect(cleanup.failedKillManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillManagedClientPids).toEqual([43210]);
    expect(killedPids).toEqual([]);
  });

  it('skips unmanaged child pid during stale cleanup', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_unmanaged_child_1',
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_unmanaged_child_1']);
    expect(cleanup.killedManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillManagedClientPids).toEqual([54321]);
    expect(killedPids).toEqual([]);
  });

  it('dead tmux cleanup attempts terminate for managed sessions and child process', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_dead_managed',
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_dead_managed']);
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
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_dead_mapping',
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
    const record = internal.records.get('sessiond_dead_mapping');
    expect(record).toBeDefined();
    if (record) {
      record.conversationSessionIds = [];
    }

    const cleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive: () => false,
      terminateManagedTmuxSession: () => true
    });

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_dead_mapping']);
    expect(cleanup.removedTmuxSessionIds).toEqual(['rcc_dead_mapping']);
    expect(cleanup.removedConversationSessionIds).toContain('conv_dead_mapping');

    const unbound = registry.unbindConversationSession('conv_dead_mapping');
    expect(unbound.ok).toBe(true);
    expect(unbound.removed).toBe(false);
  });

  it('stale cleanup ignores terminate failures and still removes managed record', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_stale_managed_fail',
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_stale_managed_fail']);
    expect(cleanup.removedTmuxSessionIds).toEqual([]);
    expect(cleanup.failedKillTmuxSessionIds).toEqual([]);
    expect(cleanup.failedKillManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_stale_managed_fail']);
    expect(cleanup.skippedKillManagedClientPids).toEqual([55667]);
    const alive = registry.list().map((item) => item.daemonId);
    expect(alive).not.toContain('sessiond_stale_managed_fail');
  });

  it('stale cleanup preserves conversation mapping for tmux sessions that are still alive', async () => {
    const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-stale-alive-'));
    process.env.ROUTECODEX_SESSION_DIR = tempSessionDir;

    try {
      const registry = new SessionClientRegistry();
      registry.register({
        daemonId: 'sessiond_stale_alive_mapping',
        callbackUrl: 'http://127.0.0.1:65570/inject',
        tmuxSessionId: 'rcc_stale_alive_mapping'
      });
      const bind = registry.bindConversationSession({
        conversationSessionId: 'conv_stale_alive_mapping',
        daemonId: 'sessiond_stale_alive_mapping'
      });
      expect(bind.ok).toBe(true);

      const internal = registry as unknown as {
        records: Map<string, { lastHeartbeatAtMs: number }>;
      };
      const staleRecord = internal.records.get('sessiond_stale_alive_mapping');
      expect(staleRecord).toBeDefined();
      if (staleRecord) {
        staleRecord.lastHeartbeatAtMs = 0;
      }

      const cleanup = registry.cleanupStaleHeartbeats({
        nowMs: Date.now() + 60_000,
        staleAfterMs: 1,
        isTmuxSessionAlive: () => true
      });

      expect(cleanup.removedDaemonIds).toEqual(['sessiond_stale_alive_mapping']);
      expect(cleanup.removedTmuxSessionIds).toEqual([]);
      expect(cleanup.removedConversationSessionIds).toEqual([]);

      const bindingsPath = path.join(tempSessionDir, 'session-bindings.json');
      const persisted = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
      expect(persisted.records).toEqual([]);
      expect(persisted.conversationToTmuxSession).toEqual({
        conv_stale_alive_mapping: 'rcc_stale_alive_mapping'
      });
    } finally {
      if (originalSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
      }
      fs.rmSync(tempSessionDir, { recursive: true, force: true });
    }
  });

  it('keeps dead tmux managed record when terminate fails', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_dead_managed_fail',
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
    expect(alive).toContain('sessiond_dead_managed_fail');
  });

  it('dead tmux cleanup skips terminate for unmanaged sessions', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_dead_unmanaged',
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

    expect(cleanup.removedDaemonIds).toEqual(['sessiond_dead_unmanaged']);
    expect(cleanup.killedTmuxSessionIds).toEqual([]);
    expect(cleanup.skippedKillTmuxSessionIds).toEqual(['rcc_dead_unmanaged']);
    expect(killed).toEqual([]);
  });

  it('dead tmux cleanup does not terminate managed process without managed tmux session', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_proc_only',
      callbackUrl: 'http://127.0.0.1:65559/inject',
      sessionId: 'sessiond_proc_only',
      managedClientProcess: true,
      managedClientPid: 77889,
      managedClientCommandHint: 'codex',
      clientType: 'codex'
    });

    const killedPids: number[] = [];
    const cleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive: () => false,
      terminateManagedClientProcess: ({ pid }) => {
        killedPids.push(pid);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toEqual([]);
    expect(cleanup.killedManagedClientPids).toEqual([]);
    expect(cleanup.skippedKillManagedClientPids).toEqual([77889]);
    expect(killedPids).toEqual([]);
    expect(registry.list().map((item) => item.daemonId)).toContain('sessiond_proc_only');
  });

  it('dead tmux cleanup still removes unmanaged tmux records when process-only managed clients exist', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_dead_unmanaged_cov',
      callbackUrl: 'http://127.0.0.1:65560/inject',
      tmuxSessionId: 'rcc_dead_unmanaged_cov'
    });
    registry.register({
      daemonId: 'sessiond_proc_only_cov',
      callbackUrl: 'http://127.0.0.1:65561/inject',
      sessionId: 'sessiond_proc_only_cov',
      managedClientProcess: true,
      managedClientPid: 88990,
      managedClientCommandHint: 'claude',
      clientType: 'claude'
    });

    const killedPids: number[] = [];
    const cleanup = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive: () => false,
      terminateManagedClientProcess: ({ pid }) => {
        killedPids.push(pid);
        return true;
      }
    });

    expect(cleanup.removedDaemonIds).toContain('sessiond_dead_unmanaged_cov');
    expect(cleanup.removedDaemonIds).not.toContain('sessiond_proc_only_cov');
    expect(cleanup.removedTmuxSessionIds).toContain('rcc_dead_unmanaged_cov');
    expect(cleanup.skippedKillManagedClientPids).toContain(88990);
    expect(cleanup.killedManagedClientPids).toEqual([]);
    expect(killedPids).toEqual([]);
    expect(registry.list().map((item) => item.daemonId)).toContain('sessiond_proc_only_cov');
  });

  it('bindConversationSession enforces workdir-scoped candidate selection', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_workdir_a',
      callbackUrl: 'http://127.0.0.1:65550/inject',
      tmuxSessionId: 'rcc_workdir_a',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-a'
    });
    registry.register({
      daemonId: 'sessiond_workdir_b',
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
    expect(bindA.daemonId).toBe('sessiond_workdir_a');

    const bindAChild = registry.bindConversationSession({
      conversationSessionId: 'conv_workdir_a_child',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-a/subdir/nested'
    });
    expect(bindAChild.ok).toBe(true);
    expect(bindAChild.daemonId).toBe('sessiond_workdir_a');

    const bindMissing = registry.bindConversationSession({
      conversationSessionId: 'conv_workdir_missing',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-missing'
    });
    expect(bindMissing.ok).toBe(false);
    expect(bindMissing.reason).toBe('no_binding_candidate_for_workdir');
  });

  it('bindConversationSession accepts ancestor workdir when only one daemon matches path tree', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_workdir_single',
      callbackUrl: 'http://127.0.0.1:65581/inject',
      tmuxSessionId: 'rcc_workdir_single',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-single/subdir'
    });

    const bindByAncestor = registry.bindConversationSession({
      conversationSessionId: 'conv_workdir_single_ancestor',
      clientType: 'codex',
      workdir: '/tmp/routecodex-workdir-single'
    });

    expect(bindByAncestor.ok).toBe(true);
    expect(bindByAncestor.daemonId).toBe('sessiond_workdir_single');
  });

  it('inject enforces workdir when tmux session is shared', async () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_shared_tmux_a',
      callbackUrl: 'http://127.0.0.1:65552/inject',
      tmuxSessionId: 'rcc_shared_tmux_workdir',
      workdir: '/tmp/routecodex-shared-workdir-a'
    });
    registry.register({
      daemonId: 'sessiond_shared_tmux_b',
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
      expect(injectA.daemonId).toBe('sessiond_shared_tmux_a');

      const injectAChild = await registry.inject({
        tmuxSessionId: 'rcc_shared_tmux_workdir',
        workdir: '/tmp/routecodex-shared-workdir-a/subdir',
        text: 'hello-a-child'
      });
      expect(injectAChild.ok).toBe(true);
      expect(injectAChild.daemonId).toBe('sessiond_shared_tmux_a');

      const injectB = await registry.inject({
        tmuxSessionId: 'rcc_shared_tmux_workdir',
        workdir: '/tmp/routecodex-shared-workdir-b',
        text: 'hello-b'
      });
      expect(injectB.ok).toBe(true);
      expect(injectB.daemonId).toBe('sessiond_shared_tmux_b');

      const mismatch = await registry.inject({
        tmuxSessionId: 'rcc_shared_tmux_workdir',
        workdir: '/tmp/routecodex-shared-workdir-c',
        text: 'hello-c'
      });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.reason).toBe('workdir_mismatch');
      expect(hits).toEqual([
        'http://127.0.0.1:65552/inject',
        'http://127.0.0.1:65552/inject',
        'http://127.0.0.1:65553/inject'
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('persists conversation->tmux bindings across registry instances', async () => {
    const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-session-bindings-'));
    process.env.ROUTECODEX_SESSION_DIR = tempSessionDir;

    const daemonId = 'sessiond_persist_bindings';
    const tmuxSessionId = 'rcc_persist_bindings';
    const callbackUrl = 'http://127.0.0.1:65559/inject';
    try {
      const registryA = new SessionClientRegistry();
      registryA.register({
        daemonId,
        callbackUrl,
        tmuxSessionId
      });
      const bound = registryA.bindConversationSession({
        conversationSessionId: 'conv_persist_bindings'
      });
      expect(bound.ok).toBe(true);
      expect(bound.tmuxSessionId).toBe(tmuxSessionId);

      const registryB = new SessionClientRegistry();
      registryB.register({
        daemonId,
        callbackUrl,
        tmuxSessionId
      });

      const originalFetch = global.fetch;
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        text: async () => ''
      })) as typeof fetch;
      try {
        const injected = await registryB.inject({
          sessionId: 'conv_persist_bindings',
          text: 'persisted binding works'
        });
        expect(injected.ok).toBe(true);
        expect(injected.daemonId).toBe(daemonId);
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      if (originalSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
      }
      fs.rmSync(tempSessionDir, { recursive: true, force: true });
    }
  });

  it('resolveBoundWorkdir prefers daemon startup workdir for bound conversation', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_bound_workdir',
      callbackUrl: 'http://127.0.0.1:65591/inject',
      tmuxSessionId: 'rcc_bound_workdir',
      workdir: '/tmp/routecodex-bound-workdir/root'
    });
    const bind = registry.bindConversationSession({
      conversationSessionId: 'conv_bound_workdir',
      daemonId: 'sessiond_bound_workdir'
    });
    expect(bind.ok).toBe(true);

    const workdir = registry.resolveBoundWorkdir('conv_bound_workdir');
    expect(workdir).toBe('/tmp/routecodex-bound-workdir/root');
  });

  it('resolveBoundWorkdir returns undefined when multiple alive daemons under same tmux disagree', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_bound_conflict_a',
      callbackUrl: 'http://127.0.0.1:65592/inject',
      tmuxSessionId: 'rcc_bound_conflict',
      workdir: '/tmp/routecodex-bound-conflict/a'
    });
    registry.register({
      daemonId: 'sessiond_bound_conflict_b',
      callbackUrl: 'http://127.0.0.1:65593/inject',
      tmuxSessionId: 'rcc_bound_conflict',
      workdir: '/tmp/routecodex-bound-conflict/b'
    });
    const bind = registry.bindConversationSession({
      conversationSessionId: 'conv_bound_conflict',
      tmuxSessionId: 'rcc_bound_conflict'
    });
    expect(bind.ok).toBe(true);

    const workdir = registry.resolveBoundWorkdir('conv_bound_conflict');
    expect(workdir).toBeUndefined();
  });

  it('unbindSessionScope removes daemon-scoped conversation mapping', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_scope_unbind',
      callbackUrl: 'http://127.0.0.1:65594/inject',
      tmuxSessionId: 'rcc_scope_unbind'
    });
    const bind = registry.bindConversationSession({
      conversationSessionId: 'sessiond.sessiond_scope_unbind',
      daemonId: 'sessiond_scope_unbind'
    });
    expect(bind.ok).toBe(true);

    const result = registry.unbindSessionScope('sessiond.sessiond_scope_unbind');
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.daemonIds).toEqual(['sessiond_scope_unbind']);
  });

  it('unbindSessionScope removes all mappings for tmux scope', () => {
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_tmux_scope_a',
      callbackUrl: 'http://127.0.0.1:65595/inject',
      tmuxSessionId: 'rcc_scope_tmux_a'
    });
    registry.register({
      daemonId: 'sessiond_tmux_scope_b',
      callbackUrl: 'http://127.0.0.1:65596/inject',
      tmuxSessionId: 'rcc_scope_tmux_a'
    });
    expect(
      registry.bindConversationSession({
        conversationSessionId: 'sessiond.sessiond_tmux_scope_a',
        daemonId: 'sessiond_tmux_scope_a'
      }).ok
    ).toBe(true);
    expect(
      registry.bindConversationSession({
        conversationSessionId: 'sessiond.sessiond_tmux_scope_b',
        daemonId: 'sessiond_tmux_scope_b'
      }).ok
    ).toBe(true);

    const result = registry.unbindSessionScope('tmux:rcc_scope_tmux_a');
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.daemonIds.sort()).toEqual(['sessiond_tmux_scope_a', 'sessiond_tmux_scope_b']);
    expect(registry.resolveBoundTmuxSession('sessiond.sessiond_tmux_scope_a')).toBeUndefined();
    expect(registry.resolveBoundTmuxSession('sessiond.sessiond_tmux_scope_b')).toBeUndefined();
  });
});
