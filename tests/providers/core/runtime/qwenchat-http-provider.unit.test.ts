import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from '@jest/globals';

import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { QwenChatHttpProvider } from '../../../../src/providers/core/runtime/qwenchat-http-provider.js';

const emptyDeps: ModuleDependencies = {
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
  }
} as unknown as ModuleDependencies;

class RecordingHttpClient {
  public lastHeaders: Record<string, string> | undefined;

  async post(): Promise<never> {
    throw new Error('post not expected');
  }

  async postStream(
    _endpoint: string,
    _data?: unknown,
    headers?: Record<string, string>
  ): Promise<NodeJS.ReadableStream> {
    this.lastHeaders = headers ? { ...headers } : {};
    return Readable.from([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      })}\n`,
      'data: [DONE]\n'
    ]);
  }

  async get() {
    return {
      data: {},
      status: 200,
      statusText: 'OK',
      headers: {},
      url: 'https://chat.qwen.ai/api/models'
    };
  }
}

class TestQwenChatHttpProvider extends QwenChatHttpProvider {
  constructor(config: OpenAIStandardConfig, deps: ModuleDependencies) {
    super(config, deps);
  }

  protected override createHttpClient(): void {
    this.httpClient = new RecordingHttpClient() as unknown as typeof this.httpClient;
  }
}

describe('QwenChatHttpProvider', () => {
  afterEach(() => {
    delete process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS;
  });

  it('forces chat.qwen.ai baseUrl when runtime compatibility profile is chat:qwen', async () => {
    const provider = new TestQwenChatHttpProvider({
      id: 'test-qwen-chat-compat',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        auth: {
          type: 'qwen-oauth'
        },
        overrides: {}
      }
    } as unknown as OpenAIStandardConfig, emptyDeps);

    await provider.initialize();
    provider.setRuntimeProfile({
      providerFamily: 'qwen',
      providerId: 'qwen',
      providerKey: 'qwen.1.qwen3.6-plus',
      providerType: 'openai',
      compatibilityProfile: 'chat:qwen'
    } as any);

    expect((provider as any).getEffectiveBaseUrl()).toBe('https://chat.qwen.ai');
  });

  it('passes auth-provider cookie headers into qwen send plan when forwarding is enabled', async () => {
    process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS = 'true';
    const originalFetch = globalThis.fetch;
    let createSessionCookie = '';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('sg-wum.alibaba.com/w/wu.json')) {
        return new Response('', {
          status: 200,
          headers: { etag: 'etag-qwen-test' }
        });
      }
      if (url.includes('/api/v2/chats/new')) {
        const headers = new Headers(init?.headers as HeadersInit);
        createSessionCookie = headers.get('cookie') || '';
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: 'chat-id-auth-forward'
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const provider = new TestQwenChatHttpProvider({
      id: 'test-qwenchat',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        auth: {
          type: 'apikey',
          apiKey: 'sid=test-cookie',
          headerName: 'Cookie'
        },
        overrides: {
          baseUrl: 'https://chat.qwen.ai',
          endpoint: '/api/v2/chat/completions'
        }
      }
    } as unknown as OpenAIStandardConfig, emptyDeps);

    try {
      await provider.initialize();
      const response = await (provider as any).sendRequestInternal({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false
      });

      const client = (provider as unknown as { httpClient: RecordingHttpClient }).httpClient;
      expect(createSessionCookie).toBe('sid=test-cookie');
      expect(client.lastHeaders?.Cookie).toBe('sid=test-cookie');
      expect((response as Record<string, unknown>).status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
