import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

const mockGrpcUnary = jest.fn(async (...args: unknown[]) => {
  const path = String(args[2] || '');
  if (path.endsWith('/SendUserCascadeMessage')) {
    throw Object.assign(new Error('The pending stream has been canceled (caused by: )'), {
      code: 'ERR_HTTP2_STREAM_CANCEL',
    });
  }
  return Buffer.alloc(0);
});

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
    closeSessionForPort: mockCloseSessionForPort,
    grpcFrame: (payload: Buffer) => payload,
    grpcUnaryJson: jest.fn(),
    grpcStream: jest.fn(),
    closeAllSessions: jest.fn(),
    closeSessionForHost: jest.fn(),
    closeSessionsForHost: jest.fn(),
    closeSession: jest.fn(),
    LS_SERVICE: '/exa.language_server_pb.LanguageServerService',
  };
});

jest.unstable_mockModule('child_process', async () => ({
  spawn: mockSpawn,
}));

jest.unstable_mockModule('http2', async () => ({
  connect: mockHttp2Connect,
}));

let WindsurfChatProvider: any;
let managerTestables: any;
let getOrCreateWindsurfLangserverEntry: any;
let resolveWindsurfWorkspacePath: any;

describe('WindsurfChatProvider', () => {
  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
    ({
      __windsurfLangserverManagerTestables: managerTestables,
      getOrCreateWindsurfLangserverEntry,
      resolveWindsurfWorkspacePath,
    } = await import('../../../../src/providers/core/runtime/windsurf-langserver-manager.ts'));
  });

  beforeEach(() => {
    managerTestables.clear();
    mockGrpcUnary.mockClear();
    mockCloseSessionForPort.mockClear();
    mockSpawn.mockClear();
    mockHttp2Connect.mockClear();
  });

  test('preprocessRequest converts tools into tools_preamble', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-high',
        auth: { type: 'apikey', apiKey: 'test-key' },
        extensions: {
          transportBackend: 'cascade-cloud',
          apiBaseUrl: 'https://server.self-serve.windsurf.com',
          apiBaseUrlFallback: 'https://server.codeium.com',
        },
      },
    } as any, deps);

    const processed = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-high',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
            },
          },
        ],
      },
    });

    expect(processed.body.tools).toBeUndefined();
    expect(processed.body.tools_preamble).toContain('[Available tools]');
    expect(processed.body.tools_preamble).toContain('exec_command');
  });

  test('windsurf-account resolves session token via login chain and caches it', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$abc123', accountId: 'account-123' }),
    } as any);
    global.fetch = fetchMock as any;
    try {
      const provider = new WindsurfChatProvider({
        type: 'openai-standard',
        config: {
          providerType: 'openai',
          baseUrl: 'http://localhost:3003',
          model: 'gpt-5.4-high',
          auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: '2094423@qq.com', password: 'welcome4zcam#' },
          extensions: {
            transportBackend: 'cascade-cloud',
            apiBaseUrl: 'https://server.self-serve.windsurf.com',
            apiBaseUrlFallback: 'https://server.codeium.com',
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: {},
          url: 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod',
          data: { userExists: true, hasPassword: true },
        } as any)
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: {},
          url: 'https://windsurf.com/_devin-auth/password/login',
          data: { token: 'auth1-token-123' },
        } as any);

      const first = await (provider as any).ensureWindsurfSessionCredential();
      const second = await (provider as any).ensureWindsurfSessionCredential();
      expect(first).toEqual({
        apiKey: 'devin-session-token$abc123',
        sessionToken: 'devin-session-token$abc123',
        auth1Token: 'auth1-token-123',
        accountId: 'account-123',
      });
      expect(second).toBe(first);
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((provider as any).readApiKey()).toBe('devin-session-token$abc123');
    } finally {
      global.fetch = originalFetch;
    }
  });



  test('single-turn prompt should not wrap <human> history envelope', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-key' },
      },
    } as any, deps);

    const prompt = (provider as any).buildCascadePrompt([
      { role: 'user', content: 'hello' },
    ], '');

    expect(prompt).toBe('hello');
    expect(prompt).not.toContain('<human>');
  });

  test('multi-turn prompt should wrap prior turns and latest human turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-key' },
      },
    } as any, deps);

    const prompt = (provider as any).buildCascadePrompt([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ], '');

    expect(prompt).toContain('The following is a multi-turn conversation.');
    expect(prompt).toContain('<human>\\nu1\\n</human>'.replace(/\\n/g, '\n'));
    expect(prompt).toContain('<assistant>\\na1\\n</assistant>'.replace(/\\n/g, '\n'));
    expect(prompt).toContain('<human>\\nu2\\n</human>'.replace(/\\n/g, '\n'));
  });

  test('grpc transport cancel resets manager-owned session state', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$abc123', rawType: 'windsurf-account' },
        extensions: {
          transportBackend: 'grpc',
          lsPort: 42101,
          csrfToken: 'csrf-token',
        },
      },
    } as any, deps);

    const workspacePath = resolveWindsurfWorkspacePath('devin-session-token$abc123');
    const entry = getOrCreateWindsurfLangserverEntry({
      port: 42101,
      csrfToken: 'csrf-token',
      workspacePath,
    });
    entry.sessionId = 'sess-1';
    entry.workspaceInitPromise = Promise.resolve();
    entry.ready = true;

    await expect((provider as any).sendCascadeMessage(
      'devin-session-token$abc123',
      'cascade-1',
      'hello',
      { modelEnum: 0, modelUid: 'gpt-5-4-medium' },
      entry,
    )).rejects.toThrow(/pending stream has been canceled/i);

    expect(entry.sessionId).toBeNull();
    expect(entry.workspaceInitPromise).toBeNull();
    expect(entry.ready).toBe(false);
  });

  test('weekly quota exhausted is classified into 24h account cooldown', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$abc123', rawType: 'windsurf-account' },
      },
    } as any, deps);

    const error = (provider as any).classifyWindsurfCascadeError(
      new Error('Your weekly usage quota has been exhausted. Please ensure Windsurf is up to date for the best experience, or visit windsurf.com to manage your plan.')
    );

    expect(error.code).toBe('WINDSURF_WEEKLY_QUOTA_EXHAUSTED');
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(false);
    expect(error.rateLimitKind).toBe('daily_limit');
    expect(error.cooldownOverrideMs).toBe(24 * 60 * 60_000);
    expect(error.quotaScope).toBe('weekly');
    expect(error.quotaReason).toBe('windsurf_weekly_exhausted');
  });

  test('idle trajectory after grace exits as empty completion instead of hanging on sawActive=false', async () => {
    jest.useFakeTimers();
    const originalSetTimeout = global.setTimeout;
    const fastTimeout = ((fn: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(fn, 0, ...args)) as any;
    global.setTimeout = fastTimeout;

    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$abc123', rawType: 'windsurf-account' },
        extensions: {
          windsurf: {
            pollIntervalMs: 1,
            pollMaxWaitMs: 50,
          },
        },
      },
    } as any, deps);

    const lsEntry = {
      port: 42101,
      csrfToken: 'csrf-token',
      workspacePath: '/tmp/ws',
      sessionId: 'sess-1',
      workspaceInitPromise: Promise.resolve(),
      ready: true,
      generation: 0,
    };

    mockGrpcUnary.mockImplementation(async (...args: unknown[]) => {
      const path = String(args[2] || '');
      if (path.endsWith('/GetCascadeTrajectorySteps')) {
        return Buffer.alloc(0);
      }
      if (path.endsWith('/GetCascadeTrajectory')) {
        return Buffer.from([0x10, 0x01]);
      }
      if (path.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
        return Buffer.alloc(0);
      }
      return Buffer.alloc(0);
    });

    const promise = (provider as any).pollCascadeToCompletion('cascade-1', 'gpt-5.4-medium', lsEntry, 10, 0);
    await jest.advanceTimersByTimeAsync(9000);

    await expect(promise).rejects.toThrow('windsurf cascade returned empty completion');

    global.setTimeout = originalSetTimeout;
    jest.useRealTimers();
  });
});
