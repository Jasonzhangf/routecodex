import { describe, expect, it, jest } from '@jest/globals';

describe('llmswitch bridge state-integrations', () => {
  it('logs sticky session load failures and falls back to null', async () => {
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const requireCoreDistMock = jest.fn(() => ({
      loadRoutingInstructionStateSync: () => {
        throw new Error('sticky boom');
      }
    }));

    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/module-loader.js', () => ({
      requireCoreDist: requireCoreDistMock,
      importCoreDist: jest.fn()
    }));

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');
    const out = mod.loadRoutingInstructionStateSync('session:test');

    expect(out).toBeNull();
    expect(requireCoreDistMock).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('sticky_session_store.load_state.invoke');

    warnSpy.mockRestore();
  });
});
