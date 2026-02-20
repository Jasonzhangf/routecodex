import { describe, expect, it, jest } from '@jest/globals';

const mockBindConversationSession = jest.fn();
const mockGetClockClientRegistry = jest.fn(() => ({
  bindConversationSession: mockBindConversationSession
}));

const mockClockRegistryModule = () => ({
  getClockClientRegistry: mockGetClockClientRegistry
});

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/clock-client-registry.js',
  mockClockRegistryModule
);
jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/clock-client-registry.ts',
  mockClockRegistryModule
);

describe('bindClockConversationSession', () => {
  it('binds by daemonId when tmuxSessionId is absent', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetClockClientRegistry.mockClear();

    const { bindClockConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindClockConversationSession({
      clockDaemonId: 'clockd_case_1',
      sessionId: 'session_should_not_override_daemon',
      workdir: '/tmp/routecodex-bind-daemon'
    });

    expect(mockGetClockClientRegistry).toHaveBeenCalledTimes(1);
    expect(mockBindConversationSession).toHaveBeenCalledTimes(1);
    expect(mockBindConversationSession).toHaveBeenCalledWith({
      conversationSessionId: 'clockd.clockd_case_1',
      daemonId: 'clockd_case_1',
      workdir: '/tmp/routecodex-bind-daemon'
    });
  });

  it('skips binding when both daemonId and tmuxSessionId are absent', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetClockClientRegistry.mockClear();

    const { bindClockConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindClockConversationSession({
      sessionId: 'session_only'
    });

    expect(mockGetClockClientRegistry).toHaveBeenCalledTimes(0);
    expect(mockBindConversationSession).toHaveBeenCalledTimes(0);
  });
});
