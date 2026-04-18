import { jest } from '@jest/globals';

describe('executor-metadata non-blocking observability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('logs registry lookup failures instead of silently collapsing to undefined', async () => {
    jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-client-registry.js', () => ({
      getSessionClientRegistry: () => ({
        findByDaemonId: () => {
          throw new Error('registry offline');
        },
        findByTmuxSessionId: () => {
          throw new Error('registry offline');
        },
        resolveBoundTmuxSession: () => {
          throw new Error('registry offline');
        }
      })
    }));
    jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      isTmuxSessionAlive: () => true,
      resolveTmuxSessionWorkingDirectory: () => '/tmp/ignored'
    }));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { __executorMetadataTestables } = await import(
      '../../../../src/server/runtime/http-server/executor-metadata.js'
    );

    expect(__executorMetadataTestables.resolveWorkdirFromSessionDaemon('daemon-1')).toBeUndefined();
    expect(__executorMetadataTestables.resolveWorkdirFromTmuxSessionId('tmux-1')).toBeUndefined();
    expect(__executorMetadataTestables.resolveTmuxSessionIdFromSessionDaemon('daemon-1')).toBeUndefined();
    expect(__executorMetadataTestables.resolveTmuxSessionIdFromConversationBinding('scope-1')).toBeUndefined();
    expect(__executorMetadataTestables.resolveSessionDaemonIdFromTmuxSession('tmux-1')).toBeUndefined();
    expect(__executorMetadataTestables.resolveTmuxTargetFromSessionDaemon('daemon-1')).toBeUndefined();

    const warnedStages = warnSpy.mock.calls.map(([message]) => String(message));
    expect(warnedStages.some((message) => message.includes('resolveWorkdirFromSessionDaemon failed (non-blocking)'))).toBe(true);
    expect(warnedStages.some((message) => message.includes('resolveWorkdirFromTmuxSessionId failed (non-blocking)'))).toBe(true);
    expect(warnedStages.some((message) => message.includes('resolveTmuxSessionIdFromSessionDaemon failed (non-blocking)'))).toBe(true);
    expect(warnedStages.some((message) => message.includes('resolveTmuxSessionIdFromConversationBinding failed (non-blocking)'))).toBe(true);
    expect(warnedStages.some((message) => message.includes('resolveSessionDaemonIdFromTmuxSession failed (non-blocking)'))).toBe(true);
    expect(warnedStages.some((message) => message.includes('resolveTmuxTargetFromSessionDaemon failed (non-blocking)'))).toBe(true);
  });
});
