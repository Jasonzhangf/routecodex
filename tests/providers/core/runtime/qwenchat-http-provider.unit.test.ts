import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  public postBodies: unknown[] = [];
  public postCalls = 0;
  public postStreamCalls = 0;

  async post(
    _endpoint: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<{ data: Record<string, unknown> }> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postBodies.push(data);
    this.postCalls += 1;
    return {
      data: {
        id: 'chatcmpl-qwenchat-json',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      }
    };
  }

  async postStream(
    _endpoint: string,
    _data?: unknown,
    headers?: Record<string, string>
  ): Promise<NodeJS.ReadableStream> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postStreamCalls += 1;
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

class HiddenToolRetryHttpClient extends RecordingHttpClient {
  private callCount = 0;

  override async post(
    _endpoint: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<{ data: Record<string, unknown> }> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postBodies.push(data);
    this.postCalls += 1;
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        data: {
          id: 'chatcmpl-qwenchat-native-tool-first',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3.6-plus',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call_web_search_retry',
                    type: 'function',
                    function: {
                      name: 'web_search',
                      arguments: '{"query":"RouteCodex"}'
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }
      };
    }
    return {
      data: {
        id: 'chatcmpl-qwenchat-native-tool-recovered',
        object: 'chat.completion',
        created: 2,
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'recovered-with-text-only-output'
            },
            finish_reason: 'stop'
          }
        ]
      }
    };
  }
}

class DeclaredNativeToolHttpClient extends RecordingHttpClient {
  override async post(
    _endpoint: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<{ data: Record<string, unknown> }> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postBodies.push(data);
    this.postCalls += 1;
    return {
      data: {
        id: 'chatcmpl-qwenchat-declared-native-tool',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_exec_declared',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: '{"cmd":"pwd"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      }
    };
  }
}

class SseFallbackHttpClient extends RecordingHttpClient {
  override async post(
    _endpoint: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<{ data: Record<string, unknown> }> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postBodies.push(data);
    this.postCalls += 1;
    throw Object.assign(new Error('non-stream JSON not supported by upstream'), {
      code: 'UPSTREAM_SSE_NOT_ALLOWED'
    });
  }

  override async postStream(
    _endpoint: string,
    _data?: unknown,
    headers?: Record<string, string>
  ): Promise<NodeJS.ReadableStream> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postStreamCalls += 1;
    return Readable.from([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              role: 'assistant',
              content: 'fallback-sse-ok'
            },
            finish_reason: 'stop'
          }
        ]
      })}\n`,
      'data: [DONE]\n'
    ]);
  }
}

class JsonInternalErrorFallbackHttpClient extends RecordingHttpClient {
  override async post(
    _endpoint: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<{ data: Record<string, unknown> }> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postBodies.push(data);
    this.postCalls += 1;
    return {
      data: {
        success: false,
        data: {
          code: 'Bad_Request',
          message: 'Internal Error'
        }
      }
    };
  }

  override async postStream(
    _endpoint: string,
    _data?: unknown,
    headers?: Record<string, string>
  ): Promise<NodeJS.ReadableStream> {
    this.lastHeaders = headers ? { ...headers } : {};
    this.postStreamCalls += 1;
    return Readable.from([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              role: 'assistant',
              content: 'fallback-from-json-business-error'
            },
            finish_reason: 'stop'
          }
        ]
      })}\n`,
      'data: [DONE]\n'
    ]);
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

class HiddenToolRetryProvider extends QwenChatHttpProvider {
  constructor(config: OpenAIStandardConfig, deps: ModuleDependencies) {
    super(config, deps);
  }

  protected override createHttpClient(): void {
    this.httpClient = new HiddenToolRetryHttpClient() as unknown as typeof this.httpClient;
  }
}

class DeclaredNativeToolProvider extends QwenChatHttpProvider {
  constructor(config: OpenAIStandardConfig, deps: ModuleDependencies) {
    super(config, deps);
  }

  protected override createHttpClient(): void {
    this.httpClient = new DeclaredNativeToolHttpClient() as unknown as typeof this.httpClient;
  }
}

class SseFallbackProvider extends QwenChatHttpProvider {
  constructor(config: OpenAIStandardConfig, deps: ModuleDependencies) {
    super(config, deps);
  }

  protected override createHttpClient(): void {
    this.httpClient = new SseFallbackHttpClient() as unknown as typeof this.httpClient;
  }
}

class JsonInternalErrorFallbackProvider extends QwenChatHttpProvider {
  constructor(config: OpenAIStandardConfig, deps: ModuleDependencies) {
    super(config, deps);
  }

  protected override createHttpClient(): void {
    this.httpClient = new JsonInternalErrorFallbackHttpClient() as unknown as typeof this.httpClient;
  }
}

describe('QwenChatHttpProvider', () => {
  afterEach(() => {
    delete process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS;
    delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
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
      expect(client.postCalls).toBe(1);
      expect(client.postStreamCalls).toBe(0);
      expect((client.postBodies[0] as Record<string, unknown>)?.stream).toBe(false);
      expect((client.postBodies[0] as Record<string, unknown>)?.incremental_output).toBe(false);
      expect((response as Record<string, unknown>).status).toBe(200);
      expect((response as any).data?.choices?.[0]?.message?.content).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves qwenchat non-stream delivery marker through processIncoming postprocess chain', async () => {
    process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS = 'true';
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('sg-wum.alibaba.com/w/wu.json')) {
        return new Response('', {
          status: 200,
          headers: { etag: 'etag-qwen-test' }
        });
      }
      if (url.includes('/api/v2/chats/new')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: 'chat-id-process-incoming'
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const provider = new TestQwenChatHttpProvider({
      id: 'test-qwenchat-process-incoming',
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
      const response = await provider.processIncoming({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false
      } as any);

      expect((response as any).status).toBe(200);
      expect((response as any).data?.__routecodex_qwenchat_nonstream_delivery).toBe('json');
      expect((response as any).data?.choices?.[0]?.message?.content).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries hidden native tool once in provider layer with stricter search suppression', async () => {
    const originalFetch = globalThis.fetch;
    let createSessionCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('sg-wum.alibaba.com/w/wu.json')) {
        return new Response('', {
          status: 200,
          headers: { etag: 'etag-qwen-test' }
        });
      }
      if (url.includes('/api/v2/chats/new')) {
        createSessionCount += 1;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: `chat-id-hidden-tool-${createSessionCount}`
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const provider = new HiddenToolRetryProvider({
      id: 'test-qwenchat-hidden-tool-retry',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        auth: {
          type: 'apikey',
          apiKey: 'sk-test-qwenchat-hidden-tool'
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
        stream: false,
        messages: [{ role: 'user', content: '继续，直接用 exec_command 输出 pwd。' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      });

      const client = (provider as unknown as { httpClient: HiddenToolRetryHttpClient }).httpClient;
      expect(createSessionCount).toBe(2);
      expect(client.postBodies).toHaveLength(2);
      const firstBody = client.postBodies[0] as Record<string, any>;
      const secondBody = client.postBodies[1] as Record<string, any>;
      expect(client.postCalls).toBe(2);
      expect(client.postStreamCalls).toBe(0);
      expect(firstBody.messages[0].feature_config.research_mode).toBe('off');
      expect(firstBody.messages[0].feature_config.auto_search).toBe(false);
      expect(secondBody.messages[0].feature_config.research_mode).toBe('disable');
      expect(secondBody.messages[0].feature_config.auto_search).toBe(false);
      expect((response as Record<string, unknown>).status).toBe(200);
      expect((response as any).data?.choices?.[0]?.message?.content).toBe('recovered-with-text-only-output');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts declared native tool calls in provider layer for real Codex tool context', async () => {
    const originalFetch = globalThis.fetch;
    let createSessionCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('sg-wum.alibaba.com/w/wu.json')) {
        return new Response('', {
          status: 200,
          headers: { etag: 'etag-qwen-test' }
        });
      }
      if (url.includes('/api/v2/chats/new')) {
        createSessionCount += 1;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: `chat-id-declared-native-tool-${createSessionCount}`
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const provider = new DeclaredNativeToolProvider({
      id: 'test-qwenchat-declared-native-tool',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        auth: {
          type: 'apikey',
          apiKey: 'sk-test-qwenchat-declared-native-tool'
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
        stream: false,
        messages: [{ role: 'user', content: '继续。' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          },
          {
            type: 'function',
            function: {
              name: 'update_plan',
              parameters: {
                type: 'object',
                properties: { explanation: { type: 'string' } }
              }
            }
          }
        ]
      });

      const client = (provider as unknown as { httpClient: DeclaredNativeToolHttpClient }).httpClient;
      expect(createSessionCount).toBe(1);
      expect(client.postCalls).toBe(1);
      expect(client.postStreamCalls).toBe(0);
      expect((response as any).status).toBe(200);
      expect((response as any).data?.choices?.[0]?.finish_reason).toBe('tool_calls');
      expect((response as any).data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not write qwenchat-tool-stop-no-call sample when content already contains explicit RCC tool container', async () => {
    const errorsamplesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenchat-errorsamples-'));
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsamplesDir;
    const provider = new TestQwenChatHttpProvider({
      id: 'test-qwenchat-errorsample-suppress',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        auth: {
          type: 'apikey',
          apiKey: 'sk-test-qwenchat-errorsample-suppress'
        },
        overrides: {
          baseUrl: 'https://chat.qwen.ai',
          endpoint: '/api/v2/chat/completions'
        }
      }
    } as unknown as OpenAIStandardConfig, emptyDeps);

    try {
      await (provider as any).maybeWriteSuspiciousToolStopErrorsample({
        payload: {
          tools: [
            {
              type: 'function',
              function: {
                name: 'exec_command'
              }
            }
          ]
        },
        completion: {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content:
                  '<<RCC_TOOL_CALLS_JSON\n{"tool_calls":[{"name":"exec_command","input":{"cmd":"pwd"}}]}RCC_TOOL_CALLS_JSON'
              }
            }
          ]
        },
        context: {
          requestId: 'req-qwenchat-rcc-explicit',
          providerKey: 'qwenchat.1.qwen3.6-plus',
          providerId: 'qwenchat'
        },
        url: 'https://chat.qwen.ai/api/v2/chat/completions'
      });

      const providerErrorDir = path.join(errorsamplesDir, 'provider-error');
      const files = await fs.readdir(providerErrorDir).catch(() => []);
      expect(files).toHaveLength(0);
    } finally {
      await fs.rm(errorsamplesDir, { recursive: true, force: true });
    }
  });

  it('still writes qwenchat-tool-stop-no-call sample for plain stop-without-call responses', async () => {
    const errorsamplesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenchat-errorsamples-'));
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsamplesDir;
    const provider = new TestQwenChatHttpProvider({
      id: 'test-qwenchat-errorsample-plain-stop',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        auth: {
          type: 'apikey',
          apiKey: 'sk-test-qwenchat-errorsample-plain-stop'
        },
        overrides: {
          baseUrl: 'https://chat.qwen.ai',
          endpoint: '/api/v2/chat/completions'
        }
      }
    } as unknown as OpenAIStandardConfig, emptyDeps);

    try {
      await (provider as any).maybeWriteSuspiciousToolStopErrorsample({
        payload: {
          tools: [
            {
              type: 'function',
              function: {
                name: 'exec_command'
              }
            }
          ]
        },
        completion: {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'plain-text-answer-without-tool-call'
              }
            }
          ]
        },
        context: {
          requestId: 'req-qwenchat-stop-no-call',
          providerKey: 'qwenchat.1.qwen3.6-plus',
          providerId: 'qwenchat'
        },
        url: 'https://chat.qwen.ai/api/v2/chat/completions'
      });

      const providerErrorDir = path.join(errorsamplesDir, 'provider-error');
      const files = await fs.readdir(providerErrorDir);
      expect(files.some((file) => file.startsWith('qwenchat-tool-stop-no-call-'))).toBe(true);
    } finally {
      await fs.rm(errorsamplesDir, { recursive: true, force: true });
    }
  });


  it('falls back to SSE when qwenchat JSON mode returns the known Bad_Request/Internal error contract', async () => {
    const originalFetch = globalThis.fetch;
    let createSessionCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('sg-wum.alibaba.com/w/wu.json')) {
        return new Response('', {
          status: 200,
          headers: { etag: 'etag-qwen-test' }
        });
      }
      if (url.includes('/api/v2/chats/new')) {
        createSessionCount += 1;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: `chat-id-json-business-fallback-${createSessionCount}`
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const provider = new JsonInternalErrorFallbackProvider({
      id: 'test-qwenchat-json-business-fallback',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        auth: {
          type: 'apikey',
          apiKey: 'sk-test-qwenchat-json-business-fallback'
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
        stream: false,
        messages: [{ role: 'user', content: '继续。' }]
      });

      const client = (provider as unknown as { httpClient: JsonInternalErrorFallbackHttpClient }).httpClient;
      expect(createSessionCount).toBe(1);
      expect(client.postCalls).toBe(1);
      expect(client.postStreamCalls).toBe(1);
      expect((response as Record<string, unknown>).status).toBe(200);
      expect((response as any).data?.choices?.[0]?.message?.content).toBe('fallback-from-json-business-error');
      expect((response as any).data?.__routecodex_qwenchat_nonstream_delivery).toBe('sse_fallback');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to SSE only when upstream explicitly rejects non-stream JSON mode', async () => {
    const originalFetch = globalThis.fetch;
    let createSessionCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('sg-wum.alibaba.com/w/wu.json')) {
        return new Response('', {
          status: 200,
          headers: { etag: 'etag-qwen-test' }
        });
      }
      if (url.includes('/api/v2/chats/new')) {
        createSessionCount += 1;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: `chat-id-sse-fallback-${createSessionCount}`
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const provider = new SseFallbackProvider({
      id: 'test-qwenchat-sse-fallback',
      type: 'qwenchat-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        auth: {
          type: 'apikey',
          apiKey: 'sk-test-qwenchat-sse-fallback'
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
        stream: false,
        messages: [{ role: 'user', content: '继续。' }]
      });

      const client = (provider as unknown as { httpClient: SseFallbackHttpClient }).httpClient;
      expect(createSessionCount).toBe(1);
      expect(client.postCalls).toBe(1);
      expect(client.postStreamCalls).toBe(1);
      expect((response as Record<string, unknown>).status).toBe(200);
      expect((response as any).data?.choices?.[0]?.message?.content).toBe('fallback-sse-ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
