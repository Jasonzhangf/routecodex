import { HttpTransportProvider } from '../../../../src/providers/core/runtime/http-transport-provider.js';
import { createHmac } from 'node:crypto';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { attachProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';

class RecordingHttpClient {
  public lastHeaders: Record<string, string> | undefined;
  public lastEndpoint: string | undefined;

  async post(endpoint: string, _data?: unknown, headers?: Record<string, string>) {
    this.lastEndpoint = endpoint;
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
    this.lastEndpoint = endpoint;
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
  inboundHeaders: Record<string, string>,
  runtimeMetadataExtras?: Record<string, unknown>
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
      clientHeaders: inboundHeaders,
      ...(runtimeMetadataExtras ?? {})
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

  test('injects session headers from inbound metadata when client headers are missing', async () => {
    const provider = new TestHttpTransportProvider(config, deps);
    await provider.initialize();

    const headers = await executeProviderRequest(
      provider,
      { accept: 'application/json' },
      { sessionId: 'sess-meta', conversationId: 'conv-meta' }
    );
    expect(headers['session_id']).toBe('sess-meta');
    expect(headers['conversation_id']).toBe('conv-meta');
  });

  test('does not override explicit client session headers with metadata session identifiers', async () => {
    const provider = new TestHttpTransportProvider(config, deps);
    await provider.initialize();

    const headers = await executeProviderRequest(
      provider,
      { accept: 'application/json', session_id: 'sess-header', conversation_id: 'conv-header' },
      { sessionId: 'sess-meta', conversationId: 'conv-meta' }
    );
    expect(headers['session_id']).toBe('sess-header');
    expect(headers['conversation_id']).toBe('conv-header');
  });

  test('iflow forces UA simulation (service UA overrides inbound userAgent)', async () => {
    const iflowConfig = {
      id: 'test-http-provider-iflow',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'iflow',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: {
          baseUrl: 'https://example.invalid/iflow',
          endpoint: '/chat/completions',
          defaultModel: 'glm-4.7'
        }
      }
    } as unknown as typeof config;

    const provider = new TestHttpTransportProvider(iflowConfig, deps);
    await provider.initialize();

    const providerRequest = {
      metadata: {
        stream: false,
        clientHeaders: { accept: 'application/json' }
      },
      data: {
        model: 'glm-4.7',
        messages: [{ role: 'user', content: 'hi' }]
      }
    };

    attachProviderRuntimeMetadata(providerRequest as Record<string, unknown>, {
      requestId: 'req-test-iflow-ua',
      providerId: 'iflow',
      providerKey: 'iflow.key1.glm-4.7',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      routeName: 'test',
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        userAgent: 'curl/8.7.1',
        clientHeaders: { accept: 'application/json' }
      },
      target: {
        providerKey: 'iflow.key1.glm-4.7',
        providerType: 'openai',
        compatibilityProfile: undefined,
        runtimeKey: 'iflow.key1',
        modelId: 'glm-4.7'
      }
    });

    const response = await provider.processIncoming(providerRequest as any);
    expect(response).toBeTruthy();

    const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
    const headers = client.lastHeaders || {};
    expect(headers['User-Agent']).toBe('iFlow-Cli');
  });

  test('iflow aligns CLI-style session/signature headers', async () => {
    const iflowConfig = {
      id: 'test-http-provider-iflow-signature',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'iflow',
        auth: { type: 'apikey', apiKey: 'sk-test-iflow-signature-1234567890' },
        overrides: {
          baseUrl: 'https://example.invalid/iflow',
          endpoint: '/chat/completions',
          defaultModel: 'kimi-k2.5'
        }
      }
    } as unknown as typeof config;

    const provider = new TestHttpTransportProvider(iflowConfig, deps);
    await provider.initialize();

    const providerRequest = {
      metadata: {
        stream: false,
        clientHeaders: { accept: 'application/json', session_id: 'sess-iflow-001', conversation_id: 'conv-iflow-001' }
      },
      data: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: 'hi' }]
      }
    };

    attachProviderRuntimeMetadata(providerRequest as Record<string, unknown>, {
      requestId: 'req-test-iflow-signature',
      providerId: 'iflow',
      providerKey: 'iflow.key1.kimi-k2.5',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      routeName: 'test',
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        clientHeaders: { accept: 'application/json', session_id: 'sess-iflow-001', conversation_id: 'conv-iflow-001' }
      },
      target: {
        providerKey: 'iflow.key1.kimi-k2.5',
        providerType: 'openai',
        compatibilityProfile: undefined,
        runtimeKey: 'iflow.key1',
        modelId: 'kimi-k2.5'
      }
    });

    await provider.processIncoming(providerRequest as any);

    const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
    const headers = client.lastHeaders || {};

    expect(headers['session-id']).toBe('sess-iflow-001');
    expect(headers['conversation-id']).toBe('conv-iflow-001');
    expect(typeof headers['x-iflow-timestamp']).toBe('string');
    expect(typeof headers['x-iflow-signature']).toBe('string');

    const expected = createHmac('sha256', 'sk-test-iflow-signature-1234567890')
      .update(`iFlow-Cli:sess-iflow-001:${headers['x-iflow-timestamp']}`, 'utf8')
      .digest('hex');

    expect(headers['x-iflow-signature']).toBe(expected);
  });

  test('prefers first absolute baseUrl when runtime profile baseUrl is malformed', async () => {
    const provider = new TestHttpTransportProvider(config, deps);
    await provider.initialize();
    provider.setRuntimeProfile({
      runtimeKey: 'bad.runtime',
      providerId: 'crs.key1',
      providerType: 'responses',
      providerKey: 'crs.key1.gpt-5.1-codex',
      baseUrl: '/v1beta/models:generateContent/v1beta/models:generateContent',
      endpoint: '/responses'
    } as any);

    await executeProviderRequest(provider, { accept: 'application/json' });
    const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
    expect(client.lastEndpoint).toBe('https://example.invalid/openai/responses');
  });
});
