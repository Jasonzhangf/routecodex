import { describe, expect, test, jest } from '@jest/globals';

const grpcUnaryMock = jest.fn();

jest.unstable_mockModule('../../../src/providers/core/runtime/grpc/grpc-client.js', () => ({
  grpcUnary: grpcUnaryMock,
  grpcFrame: (payload: Buffer) => payload,
  grpcStream: jest.fn(),
  LS_SERVICE: '/exa.language_server_pb.LanguageServerService',
}));

describe('windsurf chat provider transport', () => {
  test('grpc runtime uses cascade mainline instead of 501 stub', async () => {
    const deps = {
      logger: {
        logModule: jest.fn(),
        logProviderRequest: jest.fn(),
      },
    } as any;
    const superSendRequestInternal = jest.fn(async () => ({ ok: true }));
    const { HttpTransportProvider } = await import('../../../src/providers/core/runtime/http-transport-provider.js');
    const original = (HttpTransportProvider as any).prototype.sendRequestInternal;
    (HttpTransportProvider as any).prototype.sendRequestInternal = superSendRequestInternal;

    try {
      const { WindsurfChatProvider } = await import('../../../src/providers/core/runtime/windsurf-chat-provider.js');
      const provider = new WindsurfChatProvider({
        type: 'windsurf-chat-provider',
        config: {
          providerType: 'openai',
          providerId: 'windsurf',
          baseUrl: '',
          auth: {
            type: 'apikey',
            rawType: 'windsurf-account',
            apiKey: 'devin-session-token$1234567890',
          },
          compatibilityProfile: 'chat:windsurf',
          extensions: {
            windsurf: {
              transportBackend: 'grpc',
              lsPort: 42101,
              csrfToken: 'csrf-token',
            },
          },
        },
      } as any, deps);

      await provider.initialize();
      const responses = [
        Buffer.from([]), // InitializeCascadePanelState
        Buffer.from([]), // AddTrackedWorkspace
        Buffer.from([]), // UpdateWorkspaceTrust
        Buffer.from([]), // Heartbeat
        Buffer.from([]), // GetUserStatus
        Buffer.concat([Buffer.from([0x0a, 0x0b]), Buffer.from('cascade-123')]), // StartCascade
        Buffer.from([]), // SendUserCascadeMessage
        Buffer.from([
          0x0a, 0x12, // field 1, len 18
          0x08, 0x0f, // step.type = 15
          0x20, 0x01, // step.status = 1
          0xa2, 0x01, 0x0a, // field 20, len 10
          0x0a, 0x08, ...Buffer.from('hello ws'), // planner.response field 1
        ]), // GetCascadeTrajectorySteps #1
        Buffer.from([0x10, 0x02]), // GetCascadeTrajectory #1 active
        Buffer.from([]), // GetCascadeTrajectoryGeneratorMetadata #1
        Buffer.from([]), // GetCascadeTrajectorySteps #2
        Buffer.from([0x10, 0x01]), // GetCascadeTrajectory #2 idle
        Buffer.from([]), // GetCascadeTrajectoryGeneratorMetadata #2
        Buffer.from([]), // GetCascadeTrajectorySteps #3
        Buffer.from([0x10, 0x01]), // GetCascadeTrajectory #3 idle
        Buffer.from([]), // GetCascadeTrajectoryGeneratorMetadata #3
      ];
      grpcUnaryMock.mockImplementation(async () => responses.shift() ?? Buffer.from([]));

      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.5-medium',
          messages: [{ role: 'user', content: 'hi' }],
        },
      })).resolves.toEqual(expect.objectContaining({
        object: 'chat.completion',
        model: 'gpt-5.5-medium',
      }));

      expect(superSendRequestInternal).not.toHaveBeenCalled();
      expect(grpcUnaryMock).toHaveBeenCalled();
    } finally {
      (HttpTransportProvider as any).prototype.sendRequestInternal = original;
      grpcUnaryMock.mockReset();
    }
  });

  test('runtime options preserve grpc ls settings for cascade mainline', async () => {
    const { normalizeWindsurfProviderRuntimeOptions } = await import('../../../src/providers/core/contracts/windsurf-provider-contract.js');
    const normalized = normalizeWindsurfProviderRuntimeOptions({
      transportBackend: 'grpc',
      lsPort: 42101,
      csrfToken: 'csrf-token',
      apiBaseUrl: 'https://server.self-serve.windsurf.com',
      apiBaseUrlFallback: 'https://server.codeium.com',
      pollIntervalMs: 500,
      pollMaxWaitMs: 600000,
    } as any);

    expect(normalized.transportBackend).toBe('grpc');
    expect((normalized as Record<string, unknown>).lsPort).toBe(42101);
    expect((normalized as Record<string, unknown>).csrfToken).toBe('csrf-token');
    expect(normalized.apiBaseUrl).toBe('https://server.self-serve.windsurf.com');
    expect(normalized.apiBaseUrlFallback).toBe('https://server.codeium.com');
  });

  test('cloud runtime health check must not probe local grpc heartbeat', async () => {
    const { WindsurfChatProvider } = await import('../../../src/providers/core/runtime/windsurf-chat-provider.js');
    const provider = new WindsurfChatProvider({
      type: 'windsurf-chat-provider',
      config: {
        providerType: 'openai',
        providerId: 'windsurf',
        baseUrl: '',
        auth: {
          type: 'apikey',
          rawType: 'windsurf-account',
          apiKey: 'session-token-1234567890',
        },
        compatibilityProfile: 'chat:windsurf',
        extensions: {
          windsurf: {
            transportBackend: 'cascade-cloud',
            apiBaseUrl: 'https://server.self-serve.windsurf.com',
            apiBaseUrlFallback: 'https://server.codeium.com',
          },
        },
      },
    } as any, { logger: { logModule: jest.fn(), logProviderRequest: jest.fn() } } as any);

    await provider.checkHealth();
    expect(grpcUnaryMock).not.toHaveBeenCalled();
  });
});
