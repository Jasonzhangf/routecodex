import { describe, expect, test, jest, beforeEach } from '@jest/globals';

const mockGrpcUnary = jest.fn(async () => Buffer.alloc(0));
const mockCloseSessionForPort = jest.fn();
const mockSpawn = jest.fn(() => ({
  on: jest.fn(),
  stdout: { on: jest.fn() },
  stderr: { on: jest.fn() },
  kill: jest.fn(),
}));
const mockHttp2Connect = jest.fn(() => ({
  on: (event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'connect') {
      setTimeout(() => cb(), 0);
    }
  },
  close: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/providers/core/runtime/grpc/grpc-client.js', async () => {
  return {
    grpcUnary: mockGrpcUnary,
    grpcStream: jest.fn(),
    closeSessionForPort: mockCloseSessionForPort,
    grpcFrame: (payload: Buffer) => payload,
    LS_SERVICE: '/exa.language_server_pb.LanguageServerService',
  };
});

jest.unstable_mockModule('child_process', async () => ({
  spawn: mockSpawn,
}));

jest.unstable_mockModule('http2', async () => ({
  connect: mockHttp2Connect,
}));

describe('windsurf-langserver-manager', () => {
  beforeEach(async () => {
    const mod = await import('../../../../src/providers/core/runtime/windsurf-langserver-manager.js');
    mod.__windsurfLangserverManagerTestables.clear();
    mockGrpcUnary.mockReset();
    mockCloseSessionForPort.mockReset();
    mockSpawn.mockClear();
    mockHttp2Connect.mockClear();
  });

  test('ensureWindsurfLangserverReady owns session/workspace readiness on entry', async () => {
    mockGrpcUnary.mockResolvedValue(Buffer.alloc(0));
    const {
      ensureWindsurfLangserverReady,
      resolveWindsurfWorkspacePath,
    } = await import('../../../../src/providers/core/runtime/windsurf-langserver-manager.js');

    const apiKey = 'devin-session-token$abc123';
    const workspacePath = resolveWindsurfWorkspacePath(apiKey);

    const entry = await ensureWindsurfLangserverReady({
      apiKey,
      workspacePath,
    });

    expect(entry.port).toBeGreaterThanOrEqual(42100);
    expect(entry.csrfToken).toBeTruthy();
    expect(entry.workspacePath).toBe(workspacePath);
    expect(entry.sessionId).toBeTruthy();
    expect(entry.ready).toBe(true);
    expect(entry.workspaceInitPromise).toBeTruthy();
    expect(mockGrpcUnary).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
  });

  test('ensureWindsurfLangserverReady reuses same entry without rebuilding workspace', async () => {
    mockGrpcUnary.mockResolvedValue(Buffer.alloc(0));
    const {
      ensureWindsurfLangserverReady,
      resolveWindsurfWorkspacePath,
    } = await import('../../../../src/providers/core/runtime/windsurf-langserver-manager.js');

    const apiKey = 'devin-session-token$reuse123';
    const workspacePath = resolveWindsurfWorkspacePath(apiKey);

    const first = await ensureWindsurfLangserverReady({
      apiKey,
      workspacePath,
    });
    const firstCalls = mockGrpcUnary.mock.calls.length;
    const second = await ensureWindsurfLangserverReady({
      apiKey,
      workspacePath,
    });

    expect(second).toBe(first);
    expect(mockGrpcUnary.mock.calls.length).toBe(firstCalls);
  });

  test('resetWindsurfLangserverSession clears session ownership on entry', async () => {
    const {
      getOrCreateWindsurfLangserverEntry,
      resetWindsurfLangserverSession,
      resolveWindsurfWorkspacePath,
    } = await import('../../../../src/providers/core/runtime/windsurf-langserver-manager.js');

    const workspacePath = resolveWindsurfWorkspacePath('devin-session-token$reset123');
    const entry = getOrCreateWindsurfLangserverEntry({
      port: 42101,
      csrfToken: 'csrf-token',
      workspacePath,
    });
    entry.sessionId = 'sess-1';
    entry.workspaceInitPromise = Promise.resolve();
    entry.ready = true;
    entry.generation = 2;

    resetWindsurfLangserverSession(entry);

    expect(entry.sessionId).toBeNull();
    expect(entry.workspaceInitPromise).toBeNull();
    expect(entry.ready).toBe(false);
    expect(entry.generation).toBe(3);
    expect(mockCloseSessionForPort).toHaveBeenCalledWith(42101);
  });
});
