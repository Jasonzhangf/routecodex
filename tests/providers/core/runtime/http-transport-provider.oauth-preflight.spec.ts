import { jest } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

describe('HttpTransportProvider oauth preflight', () => {
  test('throws auth error and triggers background repair when ensureValid detects invalid token', async () => {
    jest.resetModules();

    const ensureValidOAuthToken = jest.fn(async () => {
      throw new Error('Token refresh failed (permanent): OAuth error: invalid_grant - Token has been expired or revoked.');
    });
    const handleUpstreamInvalidOAuthToken = jest.fn(async () => false);
    const shouldTriggerInteractiveOAuthRepair = jest.fn(() => true);

    jest.unstable_mockModule('../../../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken,
      handleUpstreamInvalidOAuthToken,
      shouldTriggerInteractiveOAuthRepair
    }));

    const mockedLifecycle = await import('../../../../src/providers/auth/oauth-lifecycle.js');
    expect(jest.isMockFunction(mockedLifecycle.ensureValidOAuthToken)).toBe(true);

    const [{ HttpTransportProvider }, { attachProviderRuntimeMetadata }, fs, os, path] = await Promise.all([
      import('../../../../src/providers/core/runtime/http-transport-provider.js'),
      import('../../../../src/providers/core/runtime/provider-runtime-metadata.js'),
      import('node:fs/promises'),
      import('node:os'),
      import('node:path')
    ]);

    class RecordingHttpClient {
      public postCalls = 0;

      async post(endpoint: string, _data?: unknown, headers?: Record<string, string>) {
        this.postCalls += 1;
        return {
          data: { ok: true },
          status: 200,
          statusText: 'OK',
          headers: headers ?? {},
          url: endpoint
        };
      }

      async postStream(): Promise<NodeJS.ReadableStream> {
        throw new Error('postStream not implemented in stub');
      }

      async get(endpoint: string, headers?: Record<string, string>) {
        return {
          data: {},
          status: 200,
          statusText: 'OK',
          headers: headers ?? {},
          url: endpoint
        };
      }
    }

    class TestHttpTransportProvider extends HttpTransportProvider {
      constructor(config: OpenAIStandardConfig, deps: ModuleDependencies) {
        super(config, deps, 'test-http-provider');
      }

      protected override createHttpClient(): void {
        const client = new RecordingHttpClient();
        this.httpClient = client as unknown as typeof this.httpClient;
      }

      protected override wantsUpstreamSse(): boolean {
        return false;
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-oauth-preflight-'));
    const tokenFile = path.join(tempDir, 'iflow-oauth-test.json');
    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'stale-token', expires_at: Date.now() - 60_000 }), 'utf8');

    const config: OpenAIStandardConfig = {
      id: 'test-http-provider-oauth-preflight',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'iflow',
        auth: { type: 'iflow-oauth', tokenFile } as any,
        overrides: {
          baseUrl: 'https://example.invalid/openai',
          defaultModel: 'gpt-5.1-codex'
        }
      }
    };

    const noopLogger: PipelineDebugLogger = {
      logModule: () => {},
      logError: () => {},
      logDebug: () => {},
      logPipeline: () => {},
      logRequest: () => {},
      logResponse: () => {},
      logTransformation: () => {},
      logProviderRequest: () => {},
      getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
      getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }),
      getRecentLogs: () => [],
      getTransformationLogs: () => [],
      getProviderLogs: () => [],
      getStatistics: () => ({
        totalLogs: 0,
        logsByLevel: {},
        logsByCategory: {},
        logsByPipeline: {},
        transformationCount: 0,
        providerRequestCount: 0
      }),
      clearLogs: () => {},
      exportLogs: () => [],
      log: () => {}
    };

    const deps: ModuleDependencies = {
      errorHandlingCenter: {
        handleError: async () => {},
        createContext: () => ({}),
        getStatistics: () => ({})
      },
      debugCenter: {
        logDebug: () => {},
        logError: () => {},
        logModule: () => {},
        processDebugEvent: () => {},
        getLogs: () => []
      },
      logger: noopLogger
    };

    const provider = new TestHttpTransportProvider(config, deps);
    await provider.initialize();

    const providerRequest = {
      metadata: {
        stream: false,
        clientHeaders: { accept: 'application/json' }
      },
      data: {
        model: 'gpt-5.1-codex',
        input: []
      }
    };

    attachProviderRuntimeMetadata(providerRequest as Record<string, unknown>, {
      requestId: 'req-oauth-preflight',
      providerId: 'iflow',
      providerKey: 'iflow.key1.gpt-5.1-codex',
      providerType: 'responses',
      providerProtocol: 'openai-responses',
      routeName: 'test',
      metadata: {
        entryEndpoint: '/v1/responses',
        clientHeaders: { accept: 'application/json' }
      },
      target: {
        providerKey: 'iflow.key1.gpt-5.1-codex',
        providerType: 'responses',
        compatibilityProfile: undefined,
        runtimeKey: 'iflow.key1',
        modelId: 'gpt-5.1-codex'
      }
    });

    await expect(provider.processIncoming(providerRequest as any)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_TOKEN'
    });

    expect(ensureValidOAuthToken).toHaveBeenCalledTimes(1);
    expect(shouldTriggerInteractiveOAuthRepair).toHaveBeenCalledTimes(1);
    expect(handleUpstreamInvalidOAuthToken).toHaveBeenCalledTimes(1);
    expect(handleUpstreamInvalidOAuthToken).toHaveBeenCalledWith(
      'iflow',
      expect.objectContaining({ type: 'iflow-oauth' }),
      expect.objectContaining({ code: 'AUTH_INVALID_TOKEN' }),
      expect.objectContaining({ allowBlocking: false })
    );

    const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
    expect(client.postCalls).toBe(0);
  });
});
