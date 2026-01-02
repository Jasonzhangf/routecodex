import { HttpTransportProvider } from '../../../../src/providers/core/runtime/http-transport-provider.js';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { attachProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';

class RecordingHttpClient {
  public lastHeaders: Record<string, string> | undefined;

  async post(endpoint: string, _data?: unknown, headers?: Record<string, string>) {
    this.lastHeaders = headers ? { ...headers } : {};
    return {
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
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
    // Replace the default HTTP client with a stub so we can capture headers.
    const client = new RecordingHttpClient();
    this.httpClient = client as unknown as typeof this.httpClient;
  }

  protected override wantsUpstreamSse(): boolean {
    // Keep default non-streaming path so we exercise standard header building.
    return false;
  }
}

const config: OpenAIStandardConfig = {
  id: 'test-http-provider',
  type: 'responses-http-provider',
  config: {
    providerType: 'responses',
    providerId: 'crs.key1',
    auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
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

async function executeProviderRequest(
  provider: TestHttpTransportProvider,
  inboundHeaders: Record<string, string>
): Promise<Record<string, string>> {
  const providerRequest = {
    metadata: {
      stream: true,
      clientHeaders: inboundHeaders
    },
    data: {
      model: 'gpt-5.1-codex',
      input: []
    }
  };

  attachProviderRuntimeMetadata(providerRequest as Record<string, unknown>, {
    requestId: 'req-test',
    providerId: 'crs.key1',
    providerKey: 'crs.key1.gpt-5.1-codex',
    providerType: 'responses',
    providerProtocol: 'openai-responses',
    routeName: 'test',
    metadata: {
      entryEndpoint: '/v1/responses',
      clientHeaders: inboundHeaders
    },
    target: {
      providerKey: 'crs.key1.gpt-5.1-codex',
      providerType: 'responses',
      compatibilityProfile: undefined,
      runtimeKey: 'crs.key1',
      modelId: 'gpt-5.1-codex'
    }
  });

  const response = await provider.processIncoming(providerRequest as any);
  expect(response).toBeTruthy();
  const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
  return client.lastHeaders || {};
}

describe('HttpTransportProvider header propagation', () => {
  test('forwards inbound client headers into upstream HTTP headers', async () => {
    const provider = new TestHttpTransportProvider(config, deps);
    await provider.initialize();

    const inboundHeaders = {
      accept: 'text/event-stream',
      conversation_id: 'conv-123',
      session_id: 'sess-456'
    };

    const headers = await executeProviderRequest(provider, inboundHeaders);
    expect(headers['conversation_id']).toBe('conv-123');
    expect(headers['session_id']).toBe('sess-456');
  });

  test('normalizes session headers without separators', async () => {
    const provider = new TestHttpTransportProvider(config, deps);
    await provider.initialize();

    const inboundHeaders = {
      accept: 'application/json',
      conversationid: 'conv-789',
      sessionid: 'sess-999'
    };

    const headers = await executeProviderRequest(provider, inboundHeaders);
    expect(headers['conversation_id']).toBe('conv-789');
    expect(headers['session_id']).toBe('sess-999');
  });
});
