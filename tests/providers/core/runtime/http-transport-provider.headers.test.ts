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

  test('opencode zen forwards opencode routing headers and removes codex session/originator headers', async () => {
    const zenConfig = {
      id: 'test-http-provider-opencode-zen',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'opencode-zen-free',
        auth: { type: 'apikey', apiKey: 'public', rawType: 'opencode-zen-public' },
        overrides: {
          baseUrl: 'https://opencode.ai/zen/v1',
          endpoint: '/chat/completions',
          defaultModel: 'mimo-v2-pro-free'
        }
      }
    } as unknown as typeof config;

    const provider = new TestHttpTransportProvider(zenConfig, deps);
    await provider.initialize();

    const providerRequest = {
      metadata: {
        stream: false,
        clientHeaders: {
          accept: 'application/json',
          session_id: 'sess-zen',
          conversation_id: 'conv-zen',
          'x-opencode-project': 'proj-zen',
          'x-opencode-session': 'session-zen',
          'x-opencode-request': 'user-zen',
          'x-opencode-client': 'cli'
        }
      },
      data: {
        model: 'mimo-v2-pro-free',
        messages: [{ role: 'user', content: 'hello' }]
      }
    };

    attachProviderRuntimeMetadata(providerRequest as Record<string, unknown>, {
      requestId: 'req-test-zen-headers',
      providerId: 'opencode-zen-free',
      providerKey: 'opencode-zen-free.key1.mimo-v2-pro-free',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      routeName: 'thinking',
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        clientHeaders: {
          accept: 'application/json',
          session_id: 'sess-zen',
          conversation_id: 'conv-zen',
          'x-opencode-project': 'proj-zen',
          'x-opencode-session': 'session-zen',
          'x-opencode-request': 'user-zen',
          'x-opencode-client': 'cli'
        }
      },
      target: {
        providerKey: 'opencode-zen-free.key1.mimo-v2-pro-free',
        providerType: 'openai',
        compatibilityProfile: undefined,
        runtimeKey: 'opencode-zen-free.key1',
        modelId: 'mimo-v2-pro-free'
      }
    });

    const response = await provider.processIncoming(providerRequest as any);
    expect(response).toBeTruthy();

    const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
    const headers = client.lastHeaders || {};
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer public');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['User-Agent']).toBeUndefined();
    expect(headers['originator']).toBeUndefined();
    expect(headers['session_id']).toBeUndefined();
    expect(headers['conversation_id']).toBeUndefined();
    expect(headers['x-opencode-project']).toBe('proj-zen');
    expect(headers['x-opencode-session']).toBe('session-zen');
    expect(headers['x-opencode-request']).toBe('user-zen');
    expect(headers['x-opencode-client']).toBe('cli');
  });

  test('opencode zen derives x-opencode-session/request from metadata when client x-opencode headers are absent', async () => {
    const zenConfig = {
      id: 'test-http-provider-opencode-zen-metadata',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'opencode-zen-free',
        auth: { type: 'apikey', apiKey: 'public', rawType: 'opencode-zen-public' },
        overrides: {
          baseUrl: 'https://opencode.ai/zen/v1',
          endpoint: '/chat/completions',
          defaultModel: 'mimo-v2-pro-free'
        }
      }
    } as unknown as typeof config;

    const provider = new TestHttpTransportProvider(zenConfig, deps);
    await provider.initialize();

    const providerRequest = {
      metadata: {
        stream: false,
        clientHeaders: { accept: 'application/json' }
      },
      data: {
        model: 'mimo-v2-pro-free',
        messages: [{ role: 'user', content: 'hello' }]
      }
    };

    attachProviderRuntimeMetadata(providerRequest as Record<string, unknown>, {
      requestId: 'req-test-zen-metadata',
      providerId: 'opencode-zen-free',
      providerKey: 'opencode-zen-free.key1.mimo-v2-pro-free',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      routeName: 'thinking',
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        projectId: 'proj-meta',
        sessionId: 'sess-meta',
        clientRequestId: 'client-req-meta',
        opencodeClient: 'cli'
      },
      target: {
        providerKey: 'opencode-zen-free.key1.mimo-v2-pro-free',
        providerType: 'openai',
        compatibilityProfile: undefined,
        runtimeKey: 'opencode-zen-free.key1',
        modelId: 'mimo-v2-pro-free'
      }
    });

    const response = await provider.processIncoming(providerRequest as any);
    expect(response).toBeTruthy();

    const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
    const headers = client.lastHeaders || {};
    expect(headers['x-opencode-project']).toBe('proj-meta');
    expect(headers['x-opencode-session']).toBe('sess-meta');
    expect(headers['x-opencode-request']).toBe('client-req-meta');
    expect(headers['x-opencode-client']).toBe('cli');
    expect(headers['session_id']).toBeUndefined();
    expect(headers['conversation_id']).toBeUndefined();
  });
});
