import { HttpTransportProvider } from '../../../../src/providers/core/runtime/http-transport-provider.js';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { attachProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    super(config, deps, config.type);
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

  test('gemini-cli forces stable UA and does not forward session headers', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-gemini-cli-token-'));
    const tokenFile = path.join(tmpDir, 'token.json');
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        access_token: 'test-access-token',
        expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
        project_id: 'test-project'
      }),
      'utf8'
    );

    const geminiCliConfig = {
      id: 'test-http-provider-gemini-cli',
      type: 'gemini-cli-http-provider',
      config: {
        providerType: 'gemini',
        providerId: 'gemini-cli',
        auth: { type: 'gemini-cli-oauth', tokenFile },
        overrides: {
          baseUrl: 'https://example.invalid/gemini-cli',
          endpoint: '/v1internal:generateContent',
          defaultModel: 'gemini-2.5-pro'
        }
      }
    } as unknown as typeof config;

    const provider = new TestHttpTransportProvider(geminiCliConfig, deps);
    await provider.initialize();

    const headers = await executeProviderRequest(
      provider,
      { accept: 'application/json', session_id: 'sess-should-not-leak', conversation_id: 'conv-should-not-leak' },
      { userAgent: 'codex_cli_rs/0.89.0 (Mac OS 15.7.3; arm64) iTerm.app/3.6.5' }
    );

    expect(headers['User-Agent']).toBe('google-api-nodejs-client/9.15.1');
    expect(headers['session_id']).toBeUndefined();
    expect(headers['conversation_id']).toBeUndefined();
  });
});
