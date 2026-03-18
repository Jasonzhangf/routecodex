import { describe, expect, it, jest } from '@jest/globals';

describe('executor-metadata binding fallback', () => {
  it('restores client inject scope from conversation binding when api-key carries session scope only', async () => {
    jest.resetModules();
    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      injectTmuxSessionText: async () => ({ ok: false as const, reason: 'tmux_session_not_found' as const }),
      isTmuxSessionAlive: (tmuxSessionId: string) => tmuxSessionId === 'tmux_binding_alive_1',
      resolveTmuxSessionWorkingDirectory: () => undefined
    }));

    const { buildRequestMetadata } = await import('../../../../src/server/runtime/http-server/executor-metadata.js');
    const { getSessionClientRegistry } = await import('../../../../src/server/runtime/http-server/session-client-registry.js');
    const registry = getSessionClientRegistry();
    const daemonId = 'sessiond_binding_meta_1';
    const tmuxSessionId = 'tmux_binding_alive_1';
    const conversationSessionId = 'conv_binding_from_apikey_1';
    const workdir = '/tmp/routecodex-binding-meta-1';

    registry.register({
      daemonId,
      callbackUrl: 'http://127.0.0.1:65567/inject',
      tmuxSessionId,
      workdir,
      clientType: 'codex'
    });
    registry.bindConversationSession({
      conversationSessionId,
      daemonId,
      tmuxSessionId,
      workdir
    });

    try {
      const metadata = buildRequestMetadata({
        entryEndpoint: '/v1/responses',
        method: 'POST',
        requestId: 'req-meta-binding-apikey-1',
        headers: {
          'x-routecodex-api-key': `sk-test::rcc-session:${conversationSessionId}`
        },
        query: {},
        body: { input: [] },
        metadata: {}
      } as any);

      expect(metadata.clientTmuxSessionId).toBe(tmuxSessionId);
      expect(metadata.tmuxSessionId).toBe(tmuxSessionId);
      expect(metadata.clientInjectReady).toBe(true);
      expect(metadata.clientInjectReason).toBe('tmux_session_ready');
      expect(metadata.stopMessageClientInjectSessionScope).toBe(`tmux:${tmuxSessionId}`);
      expect(metadata.clientDaemonId).toBe(daemonId);
      expect(metadata.sessionDaemonId).toBe(daemonId);
    } finally {
      registry.unbindConversationSession(conversationSessionId);
      registry.unregister(daemonId);
    }
  });
});
