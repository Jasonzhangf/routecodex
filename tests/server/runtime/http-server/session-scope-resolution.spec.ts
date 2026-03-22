import { resolveTmuxSessionIdAndSource } from '../../../../src/server/runtime/http-server/session-scope-resolution.js';

describe('session-scope-resolution', () => {
  it('falls back to daemon registry tmux when request does not carry tmux fields', () => {
    const result = resolveTmuxSessionIdAndSource({
      userMeta: {},
      bodyMeta: {},
      daemonId: 'daemon_1',
      resolveTmuxSessionIdFromDaemon: (daemonId) => (daemonId === 'daemon_1' ? 'tmux_from_registry' : undefined)
    });
    expect(result).toEqual({
      tmuxSessionId: 'tmux_from_registry',
      source: 'registry_by_daemon'
    });
  });

  it('keeps explicit metadata tmux as source-of-truth over daemon fallback', () => {
    const result = resolveTmuxSessionIdAndSource({
      userMeta: { tmuxSessionId: 'tmux_from_metadata' },
      bodyMeta: {},
      daemonId: 'daemon_1',
      resolveTmuxSessionIdFromDaemon: () => 'tmux_from_registry'
    });
    expect(result).toEqual({
      tmuxSessionId: 'tmux_from_metadata',
      source: 'metadata'
    });
  });

  it('uses conversation/session binding fallback when tmux is absent but session_id exists', () => {
    const result = resolveTmuxSessionIdAndSource({
      userMeta: {},
      bodyMeta: {},
      headers: {
        session_id: 'conv_1'
      },
      resolveTmuxSessionIdFromBinding: (scope) => (scope === 'conv_1' ? 'tmux_from_binding' : undefined)
    });

    expect(result).toEqual({
      tmuxSessionId: 'tmux_from_binding',
      source: 'registry_by_binding'
    });
  });

  it('ignores dead header tmux and falls back to binding scope', () => {
    const result = resolveTmuxSessionIdAndSource({
      userMeta: {},
      bodyMeta: {},
      headers: {
        'x-routecodex-client-tmux-session-id': 'tmux_dead',
        session_id: 'conv_2'
      },
      isTmuxSessionAlive: (tmuxSessionId) => tmuxSessionId !== 'tmux_dead',
      resolveTmuxSessionIdFromBinding: (scope) => (scope === 'conv_2' ? 'tmux_alive' : undefined)
    });

    expect(result).toEqual({
      tmuxSessionId: 'tmux_alive',
      source: 'registry_by_binding'
    });
  });

  it('uses api-key session scope as binding candidate when no session header exists', () => {
    const result = resolveTmuxSessionIdAndSource({
      userMeta: {},
      bodyMeta: {},
      headers: {
        'x-routecodex-api-key': 'sk-test::rcc-session:conv_from_apikey'
      },
      isTmuxSessionAlive: (tmuxSessionId) => tmuxSessionId !== 'conv_from_apikey',
      resolveTmuxSessionIdFromBinding: (scope) => (scope === 'conv_from_apikey' ? 'tmux_from_binding' : undefined)
    });

    expect(result).toEqual({
      tmuxSessionId: 'tmux_from_binding',
      source: 'registry_by_binding'
    });
  });
});
