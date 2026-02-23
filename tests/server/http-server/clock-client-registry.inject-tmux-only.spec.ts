import { describe, expect, it, jest } from '@jest/globals';

describe('ClockClientRegistry inject tmuxOnly', () => {
  it('does not fallback to callbackUrl when tmuxOnly is enabled', async () => {
    jest.resetModules();
    const injectTmuxSessionText = jest.fn(async () => ({ ok: false, reason: 'tmux_submit_failed' as const }));
    const isTmuxSessionAlive = jest.fn(() => true);

    await jest.unstable_mockModule('../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      injectTmuxSessionText,
      isTmuxSessionAlive
    }));

    const { ClockClientRegistry } = await import('../../../src/server/runtime/http-server/clock-client-registry.js');
    const registry = new ClockClientRegistry();
    registry.register({
      daemonId: 'clockd_tmux_only_1',
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
});
