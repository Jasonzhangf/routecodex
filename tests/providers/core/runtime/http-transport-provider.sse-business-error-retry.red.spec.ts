import { jest, describe, expect, test } from '@jest/globals';
import { Readable } from 'node:stream';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
  extractSessionIdentifiersFromMetadata: () => ({}),
  reportProviderErrorToRouterPolicy: () => {},
  writeSnapshotViaHooks: async () => {},
  createResponsesSseToJsonConverter: async () => ({
    convertSseToJson: async () => ({ status: 'completed', output: [] })
  })
}));

const { HttpTransportProvider } = await import('../../../../src/providers/core/runtime/http-transport-provider.js');
const { attachProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');

class StreamingRetryHttpClient {
  public postStreamCalls = 0;

  async post(): Promise<never> {
    throw new Error('post not implemented in streaming retry stub');
  }

  async postStream(): Promise<NodeJS.ReadableStream> {
    this.postStreamCalls += 1;
    if (this.postStreamCalls === 1) {
      return Readable.from([
        'data: {"id":"mini27_error_1","choices":null,"created":1780125905,"model":"MiniMax-M2.7","object":"chat.completion","base_resp":{"status_code":2056,"status_msg":"usage limit exceeded"}}\n\n',
        'data: [DONE]\n\n'
      ]);
    }
    return Readable.from([
      'data: {"id":"chatcmpl_ok_1","object":"chat.completion.chunk","created":1780125906,"model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl_ok_1","object":"chat.completion.chunk","created":1780125906,"model":"MiniMax-M2.7","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]);
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

class StreamingRetryHttpTransportProvider extends HttpTransportProvider {
  public static currentClient: StreamingRetryHttpClient | undefined;
  public readonly recordingClient: StreamingRetryHttpClient;

  constructor(config: OpenAIStandardConfig, deps: ModuleDependencies) {
    const client = new StreamingRetryHttpClient();
    StreamingRetryHttpTransportProvider.currentClient = client;
    super(config, deps, 'test-streaming-retry-provider');
    this.recordingClient = client;
  }

  protected override createHttpClient(): void {
    this.httpClient = StreamingRetryHttpTransportProvider.currentClient as unknown as typeof this.httpClient;
  }

  protected override wantsUpstreamSse(): boolean {
    return true;
  }
}

const deps: ModuleDependencies = {
  logger: {
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
    getStatistics: () => ({}),
    clearLogs: () => {},
    exportLogs: () => [],
    log: () => {}
  }
} as unknown as ModuleDependencies;

async function readStreamText(stream: unknown): Promise<string> {
  let text = '';
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return text;
}

describe('HttpTransportProvider SSE business error retry', () => {
  test('detects first-frame SSE base_resp error before returning stream and triggers provider auto-retry', async () => {
    const retryConfig: OpenAIStandardConfig = {
      id: 'mini27-test-provider',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'mini27.key1',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: {
          baseUrl: 'https://example.invalid',
          defaultModel: 'MiniMax-M2.7'
        },
        autoRetry: {
          threshold: 1,
          codes: ['0.8200']
        }
      }
    } as OpenAIStandardConfig;
    const provider = new StreamingRetryHttpTransportProvider(retryConfig, deps);
    await provider.initialize();
    provider.setRuntimeProfile({
      runtimeKey: 'mini27.key1',
      providerId: 'mini27',
      providerType: 'openai',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      modelId: 'MiniMax-M2.7',
      baseUrl: 'https://example.invalid',
      endpoint: '/chat/completions',
      providerProtocol: 'openai-chat',
      autoRetry: {
        threshold: 1,
        codes: ['0.8200']
      }
    } as any);

    const providerRequest = {
      metadata: {
        stream: true,
        entryEndpoint: '/v1/responses'
      },
      model: 'MiniMax-M2.7',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    };
    attachProviderRuntimeMetadata(providerRequest as Record<string, unknown>, {
      requestId: 'req-mini27-sse-business-error-retry',
      providerId: 'mini27',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      metadata: {
        stream: true,
        entryEndpoint: '/v1/responses'
      },
      target: {
        providerKey: 'mini27.key1.MiniMax-M2.7',
        providerType: 'openai',
        runtimeKey: 'mini27.key1',
        modelId: 'MiniMax-M2.7'
      }
    });

    const response = await provider.processIncoming(providerRequest as any) as Record<string, unknown>;

    expect(provider.recordingClient.postStreamCalls).toBe(2);
    expect(response).toHaveProperty('__sse_responses');
    const text = await readStreamText(response.__sse_responses);
    expect(text).toContain('chatcmpl_ok_1');
    expect(text).not.toContain('base_resp');
    expect(text).not.toContain('2056');
  });
});
