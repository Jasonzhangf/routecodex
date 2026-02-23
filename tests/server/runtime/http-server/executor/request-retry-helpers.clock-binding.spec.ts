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
  it('binds by tmuxSessionId when client metadata uses new fields', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetClockClientRegistry.mockClear();

    const { bindClockConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindClockConversationSession({
      clientDaemonId: 'clientd_case_1',
      clientTmuxSessionId: 'tmux_case_1',
      sessionId: 'session_should_not_override_daemon',
      clientWorkdir: '/tmp/routecodex-bind-clientd'
    });

    expect(mockGetClockClientRegistry).toHaveBeenCalledTimes(1);
    expect(mockBindConversationSession).toHaveBeenCalledTimes(1);
    expect(mockBindConversationSession).toHaveBeenCalledWith({
      conversationSessionId: 'tmux:tmux_case_1',
      tmuxSessionId: 'tmux_case_1',
      workdir: '/tmp/routecodex-bind-clientd'
    });
  });

  it('skips binding when tmuxSessionId is absent even if daemonId exists', async () => {
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

    expect(mockGetClockClientRegistry).not.toHaveBeenCalled();
    expect(mockBindConversationSession).not.toHaveBeenCalled();
  });

  it('skips binding when daemonId is absent', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetClockClientRegistry.mockClear();

    const { bindClockConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindClockConversationSession({
      sessionId: 'session_only'
    });

    expect(mockGetClockClientRegistry).not.toHaveBeenCalled();
    expect(mockBindConversationSession).not.toHaveBeenCalled();
  });

  it('does not bind from conversationId fallback when daemonId is absent', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetClockClientRegistry.mockClear();

    const { bindClockConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindClockConversationSession({
      conversationId: 'conv_only'
    });

    expect(mockGetClockClientRegistry).not.toHaveBeenCalled();
    expect(mockBindConversationSession).not.toHaveBeenCalled();
  });
});
