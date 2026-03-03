import { describe, expect, it, jest } from '@jest/globals';

const mockBindConversationSession = jest.fn();
const mockGetSessionClientRegistry = jest.fn(() => ({
  bindConversationSession: mockBindConversationSession
}));

const mockSessionRegistryModule = () => ({
  getSessionClientRegistry: mockGetSessionClientRegistry
});

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/session-client-registry.js',
  mockSessionRegistryModule
);
jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/session-client-registry.ts',
  mockSessionRegistryModule
);

describe('bindSessionConversationSession', () => {
  it('binds by tmuxSessionId when client metadata uses new fields', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetSessionClientRegistry.mockClear();

    const { bindSessionConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindSessionConversationSession({
      sessionDaemonId: 'clientd_case_1',
      clientTmuxSessionId: 'tmux_case_1',
      sessionId: 'session_should_not_override_daemon',
      clientWorkdir: '/tmp/routecodex-bind-clientd'
    });

    expect(mockGetSessionClientRegistry).toHaveBeenCalledTimes(1);
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
    mockGetSessionClientRegistry.mockClear();

    const { bindSessionConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindSessionConversationSession({
      sessionDaemonId: 'sessiond_case_1',
      sessionId: 'session_should_not_override_daemon',
      workdir: '/tmp/routecodex-bind-daemon'
    });

    expect(mockGetSessionClientRegistry).not.toHaveBeenCalled();
    expect(mockBindConversationSession).not.toHaveBeenCalled();
  });

  it('skips binding when daemonId is absent', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetSessionClientRegistry.mockClear();

    const { bindSessionConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindSessionConversationSession({
      sessionId: 'session_only'
    });

    expect(mockGetSessionClientRegistry).not.toHaveBeenCalled();
    expect(mockBindConversationSession).not.toHaveBeenCalled();
  });

  it('does not bind from conversationId fallback when daemonId is absent', async () => {
    jest.resetModules();
    mockBindConversationSession.mockReset();
    mockGetSessionClientRegistry.mockClear();

    const { bindSessionConversationSession } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );

    bindSessionConversationSession({
      conversationId: 'conv_only'
    });

    expect(mockGetSessionClientRegistry).not.toHaveBeenCalled();
    expect(mockBindConversationSession).not.toHaveBeenCalled();
  });
});
