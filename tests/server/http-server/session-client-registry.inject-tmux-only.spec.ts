import { describe, expect, it, jest } from '@jest/globals';

describe('SessionClientRegistry inject tmuxOnly', () => {
  it('does not fallback to callbackUrl when tmuxOnly is enabled', async () => {
    jest.resetModules();
    const injectTmuxSessionText = jest.fn(async () => ({ ok: false, reason: 'tmux_submit_failed' as const }));
    const isTmuxSessionAlive = jest.fn(() => true);

    await jest.unstable_mockModule('../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      injectTmuxSessionText,
      isTmuxSessionAlive
    }));

    const { SessionClientRegistry } = await import('../../../src/server/runtime/http-server/session-client-registry.js');
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_tmux_only_1',
      callbackUrl: 'http://127.0.0.1:65599/inject',
      tmuxSessionId: 'rcc_tmux_only_1',
      tmuxTarget: 'rcc_tmux_only_1:0.0',
      clientType: 'codex'
    });

    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;
    try {
      const result = await registry.inject({
        tmuxSessionId: 'rcc_tmux_only_1',
        text: '继续执行',
        tmuxOnly: true
      });

      expect(result).toEqual({ ok: false, reason: 'tmux_submit_failed' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(injectTmuxSessionText).toHaveBeenCalledWith(
        expect.objectContaining({
          tmuxSessionId: 'rcc_tmux_only_1:0.0',
          clientType: 'codex'
        })
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('injects only the matching tmux session and never crosses sessions', async () => {
    jest.resetModules();
    const injectTmuxSessionText = jest.fn(async () => ({ ok: true as const }));
    const isTmuxSessionAlive = jest.fn(() => true);

    await jest.unstable_mockModule('../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      injectTmuxSessionText,
      isTmuxSessionAlive
    }));

    const { SessionClientRegistry } = await import('../../../src/server/runtime/http-server/session-client-registry.js');
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_tmux_only_a',
      callbackUrl: 'http://127.0.0.1:65591/inject',
      tmuxSessionId: 'rcc_tmux_only_a',
      tmuxTarget: 'rcc_tmux_only_a:0.0',
      clientType: 'codex'
    });
    registry.register({
      daemonId: 'sessiond_tmux_only_b',
      callbackUrl: 'http://127.0.0.1:65592/inject',
      tmuxSessionId: 'rcc_tmux_only_b',
      tmuxTarget: 'rcc_tmux_only_b:0.0',
      clientType: 'codex'
    });

    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;
    try {
      const result = await registry.inject({
        tmuxSessionId: 'rcc_tmux_only_a',
        text: '继续执行',
        tmuxOnly: true
      });

      expect(result).toEqual({ ok: true, daemonId: 'sessiond_tmux_only_a' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(injectTmuxSessionText).toHaveBeenCalledTimes(1);
      expect(injectTmuxSessionText).toHaveBeenCalledWith(
        expect.objectContaining({
          tmuxSessionId: 'rcc_tmux_only_a:0.0'
        })
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('delays tmux injection dispatch when delay env is configured', async () => {
    jest.useFakeTimers();
    jest.resetModules();
    const previousDelay = process.env.ROUTECODEX_CLIENT_INJECT_DELAY_MS;
    process.env.ROUTECODEX_CLIENT_INJECT_DELAY_MS = '10000';

    const injectTmuxSessionText = jest.fn(async () => ({ ok: true as const }));
    const isTmuxSessionAlive = jest.fn(() => true);

    await jest.unstable_mockModule('../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      injectTmuxSessionText,
      isTmuxSessionAlive
    }));

    const { SessionClientRegistry } = await import('../../../src/server/runtime/http-server/session-client-registry.js');
    const registry = new SessionClientRegistry();
    registry.register({
      daemonId: 'sessiond_tmux_delay_1',
      callbackUrl: 'http://127.0.0.1:65598/inject',
      tmuxSessionId: 'rcc_tmux_delay_1',
      tmuxTarget: 'rcc_tmux_delay_1:0.0',
      clientType: 'codex'
    });

    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch;

    try {
      const pending = registry.inject({
        tmuxSessionId: 'rcc_tmux_delay_1',
        text: '继续执行',
        tmuxOnly: true
      });

      await Promise.resolve();
      expect(injectTmuxSessionText).not.toHaveBeenCalled();

      jest.advanceTimersByTime(10_000);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(injectTmuxSessionText).toHaveBeenCalledWith(
        expect.objectContaining({
          tmuxSessionId: 'rcc_tmux_delay_1:0.0',
          clientType: 'codex'
        })
      );
    } finally {
      global.fetch = originalFetch;
      if (previousDelay === undefined) {
        delete process.env.ROUTECODEX_CLIENT_INJECT_DELAY_MS;
      } else {
        process.env.ROUTECODEX_CLIENT_INJECT_DELAY_MS = previousDelay;
      }
      jest.useRealTimers();
    }
  });
});
