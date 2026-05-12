import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import { DEEPSEEK_UPSTREAM_CLIENT_VERSION, DEEPSEEK_UPSTREAM_USER_AGENT } from '../../../../src/providers/core/contracts/deepseek-provider-contract.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { DeepSeekHttpProvider } from '../../../../src/providers/core/runtime/deepseek-http-provider.js';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.js', () => ({
  ensureCamoufoxFingerprintForToken: jest.fn(async () => null),
  getCamoufoxProfileDir: jest.fn((provider?: string, alias?: string) => {
    const providerPart = String(provider || 'default').trim().toLowerCase() || 'default';
    const aliasPart = String(alias || '').trim().toLowerCase();
    const profileId = aliasPart ? `rc-${providerPart}.${aliasPart}` : `rc-${providerPart}`;
    return `/tmp/${profileId}`;
  })
}));

jest.mock('../../../../src/providers/core/utils/provider-error-reporter.js', () => ({
  emitProviderError: jest.fn(),
  buildRuntimeFromProviderContext: jest.fn(() => ({ requestId: 'test-request' })),
  buildRuntimeFromCompatContext: jest.fn(() => ({ requestId: 'test-request' }))
}));

jest.mock('../../../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: jest.fn(() => ({
    recordProviderUsage: jest.fn()
  })),
  getProviderErrorCenter: jest.fn(async () => ({
    emit: jest.fn()
  }))
}));

jest.mock('../../../../src/providers/core/runtime/deepseek-session-pow.js', () => ({
  DeepSeekSessionPowManager: class MockDeepSeekSessionPowManager {
    async ensureChatSession(): Promise<string> {
      return 'mock-session-id';
    }
    async createPowResponse(): Promise<string> {
      return 'mock-pow';
    }
    async cleanup(): Promise<void> {}
  }
}));

jest.mock('../../../../src/providers/auth/deepseek-account-auth.js', () => {
  class MockDeepSeekAccountAuthProvider {
    public readonly type = 'apikey' as const;

    async initialize(): Promise<void> {}

    buildHeaders(): Record<string, string> {
      return {};
    }

    async validateCredentials(): Promise<boolean> {
      return true;
    }

    async cleanup(): Promise<void> {}

    getStatus() {
      return {
        isAuthenticated: true,
        isValid: true,
        lastValidated: Date.now()
      };
    }
  }

  return {
    DeepSeekAccountAuthProvider: MockDeepSeekAccountAuthProvider
  };
});

type FakeSessionPow = {
  ensureChatSession: jest.Mock<Promise<string>, [Record<string, string>]>;
  createPowResponse: jest.Mock<Promise<string>, [Record<string, string>]>;
  cleanup: jest.Mock<Promise<void>, []>;
};

class TestDeepSeekHttpProvider extends DeepSeekHttpProvider {
  constructor(
    config: OpenAIStandardConfig,
    dependencies: ModuleDependencies,
    private readonly fakeSessionPow: FakeSessionPow
  ) {
    super(config, dependencies);
  }

  protected override buildDeepSeekSessionPowManager() {
    return this.fakeSessionPow as any;
  }
}

const deps: ModuleDependencies = {
  logger: {
    logModule: () => {},
    logProviderRequest: () => {}
  }
} as ModuleDependencies;

const ENV_KEYS = [
  'HOME',
  'RCC_HOME',
  'ROUTECODEX_HOME',
  'ROUTECODEX_USER_DIR',
  'ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT',
  'ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE',
  'ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER'
] as const;

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
const tempDirs: string[] = [];

async function createDeepSeekTokenFile(token: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-auth-'));
  tempDirs.push(tempDir);
  const tokenFile = path.join(tempDir, 'deepseek-account-1.json');
  await fs.writeFile(tokenFile, JSON.stringify({ access_token: token }, null, 2) + '\n', 'utf8');
  return tokenFile;
}

afterEach(async () => {
  jest.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('DeepSeekHttpProvider', () => {
  it('injects pow header and wraps completion body', async () => {
    const tokenFile = await createDeepSeekTokenFile('inline-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-xyz'),
      createPowResponse: jest.fn(async () => 'pow-encoded'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    (provider as any).setRuntimeProfile({
      runtimeKey: 'deepseek-web.1',
      keyAlias: '1',
      providerId: 'deepseek-web',
      providerKey: 'deepseek-web.1.deepseek-reasoner',
      providerType: 'openai'
    });

    await provider.initialize();

    const finalizedHeaders = await (provider as any).finalizeRequestHeaders(
      {},
      {
        data: {
          model: 'deepseek-chat',
          prompt: 'hello',
          stream: true
        }
      }
    );

    const body = (provider as any).buildHttpRequestBody({
      data: {
        model: 'deepseek-chat',
        prompt: 'hello',
        thinking_enabled: true,
        search_enabled: false,
        stream: true
      }
    });

    expect(finalizedHeaders['x-ds-pow-response']).toBe('pow-encoded');
    expect(finalizedHeaders['User-Agent']).toBe(DEEPSEEK_UPSTREAM_USER_AGENT);
    expect(fakeSessionPow.ensureChatSession).toHaveBeenCalledTimes(1);
    expect(fakeSessionPow.createPowResponse).toHaveBeenCalledTimes(1);

    expect(body).toEqual({
      chat_session_id: 'session-xyz',
      parent_message_id: null,
      prompt: 'hello',
      ref_file_ids: [],
      thinking_enabled: true,
      search_enabled: false,
      stream: true
    });
  });

  it('uploads inline image contracts and appends ref_file_ids', async () => {
    const tokenFile = await createDeepSeekTokenFile('inline-image-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-inline'),
      createPowResponse: jest.fn(async () => 'pow-inline'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    (provider as any).setRuntimeProfile({
      runtimeKey: 'deepseek-web.1',
      keyAlias: '1',
      providerId: 'deepseek-web',
      providerKey: 'deepseek-web.1.deepseek-v4-vision',
      providerType: 'openai'
    });

    const httpPost = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValue({
        status: 200,
        data: { code: 0, data: { biz_data: { id: 'file-inline-1' } } }
      } as any);
    const httpGet = jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValue({
        status: 200,
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file-inline-1', status: 'processed' }] } } }
      } as any);

    await provider.initialize();

    const request = {
      data: {
        model: 'deepseek-v4-vision',
        model_type: 'vision',
        prompt: 'look at image',
        ref_file_ids: [],
        metadata: {
          deepseek: {
            inlineFiles: {
              enabled: true,
              files: [
                {
                  type: 'image',
                  imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=',
                  filename: 'smoke.png'
                }
              ]
            }
          }
        }
      }
    };

    const finalizedHeaders = await (provider as any).finalizeRequestHeaders({}, request);
    const body = (provider as any).buildHttpRequestBody(request);

    expect(finalizedHeaders['x-ds-pow-response']).toBe('pow-inline');
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(httpPost.mock.calls[0]?.[2]?.['x-model-type']).toBe('vision');
    expect(body.ref_file_ids).toEqual(['file-inline-1']);
  });

  it('waits for uploaded inline image file to become ready before using ref_file_id', async () => {
    const tokenFile = await createDeepSeekTokenFile('inline-image-wait-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-inline-ready'),
      createPowResponse: jest.fn(async () => 'pow-inline-ready'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    (provider as any).setRuntimeProfile({
      runtimeKey: 'deepseek-web.1',
      keyAlias: '1',
      providerId: 'deepseek-web',
      providerKey: 'deepseek-web.1.deepseek-v4-vision',
      providerType: 'openai'
    });

    const httpPost = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValue({
        status: 200,
        data: { code: 0, data: { biz_data: { id: 'file-inline-ready-1' } } }
      } as any);
    const httpGet = jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file-inline-ready-1', status: 'uploaded' }] } } }
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file-inline-ready-1', status: 'processed' }] } } }
      } as any);

    await provider.initialize();

    const request = {
      data: {
        model: 'deepseek-v4-vision',
        model_type: 'vision',
        prompt: 'look at image',
        ref_file_ids: [],
        metadata: {
          deepseek: {
            inlineFiles: {
              enabled: true,
              files: [
                {
                  type: 'image',
                  imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=',
                  filename: 'ready.png'
                }
              ]
            }
          }
        }
      }
    };

    await (provider as any).finalizeRequestHeaders({}, request);
    const body = (provider as any).buildHttpRequestBody(request);

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(httpGet).toHaveBeenCalledTimes(2);
    expect(body.ref_file_ids).toEqual(['file-inline-ready-1']);
  });

  it('downloads remote inline image urls and appends uploaded ref_file_ids', async () => {
    const tokenFile = await createDeepSeekTokenFile('inline-image-remote-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-inline-remote'),
      createPowResponse: jest.fn(async () => 'pow-inline-remote'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    (provider as any).setRuntimeProfile({
      runtimeKey: 'deepseek-web.1',
      keyAlias: '1',
      providerId: 'deepseek-web',
      providerKey: 'deepseek-web.1.deepseek-v4-vision',
      providerType: 'openai'
    });

    const httpPost = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValue({
        status: 200,
        data: { code: 0, data: { biz_data: { id: 'file-inline-remote-1' } } }
      } as any);
    const httpGet = jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValue({
        status: 200,
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file-inline-remote-1', status: 'processed' }] } } }
      } as any);
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      body: null,
      arrayBuffer: async () => Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00
      ]).buffer
    } as Response);

    await provider.initialize();

    const request = {
      data: {
        model: 'deepseek-v4-vision',
        model_type: 'vision',
        prompt: 'look at remote image',
        ref_file_ids: [],
        metadata: {
          deepseek: {
            inlineFiles: {
              enabled: true,
              files: [
                {
                  type: 'image',
                  imageUrl: 'https://example.com/shot.png',
                  filename: 'shot.png'
                }
              ]
            }
          }
        }
      }
    };

    await (provider as any).finalizeRequestHeaders({}, request);
    const body = (provider as any).buildHttpRequestBody(request);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/shot.png',
      expect.objectContaining({ method: 'GET', redirect: 'follow' })
    );
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(body.ref_file_ids).toEqual(['file-inline-remote-1']);
  });

  it('keeps model_type on deepseek completion payload after file upload', async () => {
    const tokenFile = await createDeepSeekTokenFile('completion-model-type-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-model-type'),
      createPowResponse: jest.fn(async () => 'pow-model-type'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    (provider as any).setRuntimeProfile({
      runtimeKey: 'deepseek-web.1',
      keyAlias: '1',
      providerId: 'deepseek-web',
      providerKey: 'deepseek-web.1.deepseek-v4-vision',
      providerType: 'openai'
    });

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      status: 200,
      data: { code: 0, data: { biz_data: { id: 'file-model-type-1' } } }
    } as any);
    jest.spyOn((provider as any).httpClient, 'get').mockResolvedValue({
      status: 200,
      data: { code: 0, data: { biz_data: { files: [{ file_id: 'file-model-type-1', status: 'processed' }] } } }
    } as any);

    await provider.initialize();
    await (provider as any).finalizeRequestHeaders({}, {
      data: {
        model: 'deepseek-v4-vision',
        model_type: 'vision',
        metadata: {
          deepseek: {
            contextFile: {
              enabled: true,
              filename: 'context',
              content: 'history',
              contentType: 'text/plain; charset=utf-8'
            }
          }
        }
      }
    });

    const body = (provider as any).buildHttpRequestBody({
      data: {
        model: 'deepseek-v4-vision',
        model_type: 'vision',
        prompt: 'look',
        ref_file_ids: []
      }
    });

    expect(body.model_type).toBe('vision');
  });

  it('infers vision upload model_type from model when explicit model_type is missing', async () => {
    const tokenFile = await createDeepSeekTokenFile('inferred-model-type-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-inferred-model-type'),
      createPowResponse: jest.fn(async () => 'pow-inferred-model-type'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    (provider as any).setRuntimeProfile({
      runtimeKey: 'deepseek-web.1',
      keyAlias: '1',
      providerId: 'deepseek-web',
      providerKey: 'deepseek-web.1.deepseek-v4-vision',
      providerType: 'openai'
    });

    const httpPost = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValue({
        status: 200,
        data: { code: 0, data: { biz_data: { id: 'file-inferred-1' } } }
      } as any);
    jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValue({
        status: 200,
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file-inferred-1', status: 'processed' }] } } }
      } as any);

    await provider.initialize();
    await (provider as any).finalizeRequestHeaders({}, {
      data: {
        model: 'deepseek-v4-vision',
        metadata: {
          deepseek: {
            inlineFiles: {
              enabled: true,
              files: [
                {
                  type: 'image',
                  imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=',
                  filename: 'inferred.png'
                }
              ]
            }
          }
        }
      }
    });

    expect(httpPost.mock.calls[0]?.[2]?.['x-model-type']).toBe('vision');
  });

  it('derives compat prompt from chat messages when prompt is missing', async () => {
    const tokenFile = await createDeepSeekTokenFile('prompt-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-xyz'),
      createPowResponse: jest.fn(async () => 'pow-encoded'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    await (provider as any).finalizeRequestHeaders(
      {},
      {
        data: {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    );

    const body = (provider as any).buildHttpRequestBody({
      data: {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }]
      }
    });

    expect(body.prompt).toContain('hi');
    expect(body.chat_session_id).toBe('session-xyz');
  });

  it('keeps tools request payload shape untouched in provider runtime', async () => {
    const tokenFile = await createDeepSeekTokenFile('tool-prompt-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-tool-1'),
      createPowResponse: jest.fn(async () => 'pow-tool-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    await (provider as any).finalizeRequestHeaders(
      {},
      {
        data: {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: '请调用工具 mailbox.status' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'mailbox.status',
                description: 'query mailbox status',
                parameters: {
                  type: 'object',
                  properties: { target: { type: 'string' } },
                  required: ['target']
                }
              }
            }
          ]
        }
      }
    );

    const body = (provider as any).buildHttpRequestBody({
      data: {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '请调用工具 mailbox.status' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'mailbox.status',
              description: 'query mailbox status',
              parameters: {
                type: 'object',
                properties: { target: { type: 'string' } },
                required: ['target']
              }
            }
          }
        ]
      }
    });

    expect(body.chat_session_id).toBe('session-tool-1');
    expect(String(body.prompt || '')).toContain('mailbox.status');
    expect(String(body.prompt || '')).not.toContain('tool_calls');
  });

  it('fails fast when compat payload prompt and messages are both missing', async () => {
    const tokenFile = await createDeepSeekTokenFile('prompt-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-xyz'),
      createPowResponse: jest.fn(async () => 'pow-encoded'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    await (provider as any).finalizeRequestHeaders(
      {},
      {
        data: {
          model: 'deepseek-chat'
        }
      }
    );

    expect(() =>
      (provider as any).buildHttpRequestBody({
        data: {
          model: 'deepseek-chat'
        }
      })
    ).toThrow();
  });

  it('builds deepseek payload without requiring openai model field', async () => {
    const tokenFile = await createDeepSeekTokenFile('model-optional-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-abc'),
      createPowResponse: jest.fn(async () => 'pow-encoded'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    await (provider as any).finalizeRequestHeaders(
      {},
      {
        data: {
          prompt: 'hello without model',
          stream: false
        }
      }
    );

    const body = (provider as any).buildHttpRequestBody({
      data: {
        prompt: 'hello without model',
        stream: false
      }
    });

    expect(body).toEqual({
      chat_session_id: 'session-abc',
      parent_message_id: null,
      prompt: 'hello without model',
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false
    });
  });

  it('forces upstream SSE for search models even when stream=false', async () => {
    const tokenFile = await createDeepSeekTokenFile('sse-search-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-sse-1'),
      createPowResponse: jest.fn(async () => 'pow-sse-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const wantsSse = (provider as any).wantsUpstreamSse(
      {
        data: {
          model: 'deepseek-chat-search',
          search_enabled: true,
          stream: false
        }
      },
      { requestId: 'req-deepseek-sse-search' } as any
    );

    expect(wantsSse).toBe(true);
  });

  it('keeps non-search requests in non-SSE mode when stream=false', async () => {
    const tokenFile = await createDeepSeekTokenFile('sse-regular-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-sse-2'),
      createPowResponse: jest.fn(async () => 'pow-sse-2'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const wantsSse = (provider as any).wantsUpstreamSse(
      {
        data: {
          model: 'deepseek-chat',
          search_enabled: false,
          stream: false
        }
      },
      { requestId: 'req-deepseek-sse-regular' } as any
    );

    expect(wantsSse).toBe(false);
  });

  it('forces upstream SSE for plain deepseek-web text requests even when stream=false', async () => {
    const tokenFile = await createDeepSeekTokenFile('sse-regular-web-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-sse-web-1'),
      createPowResponse: jest.fn(async () => 'pow-sse-web-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const wantsSse = (provider as any).wantsUpstreamSse(
      {
        data: {
          model: 'deepseek-chat',
          search_enabled: false,
          stream: false,
          prompt: 'plain text request'
        }
      },
      { requestId: 'req-deepseek-sse-regular-web' } as any
    );

    expect(wantsSse).toBe(true);
  });

  it('forces upstream SSE when deepseek-web compatibility is carried by compatibilityProfile on config', async () => {
    const tokenFile = await createDeepSeekTokenFile('sse-compat-profile-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-sse-compat-1'),
      createPowResponse: jest.fn(async () => 'pow-sse-compat-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'openai',
          compatibilityProfile: 'chat:deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const wantsSse = (provider as any).wantsUpstreamSse(
      {
        data: {
          model: 'deepseek-chat',
          search_enabled: false,
          stream: false,
          prompt: 'compatibility profile request'
        }
      },
      { requestId: 'req-deepseek-sse-compat-profile' } as any
    );

    expect(wantsSse).toBe(true);
  });

  it('forces upstream SSE for tool requests even when stream=false', async () => {
    const tokenFile = await createDeepSeekTokenFile('sse-tool-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-sse-tool'),
      createPowResponse: jest.fn(async () => 'pow-sse-tool'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const wantsSse = (provider as any).wantsUpstreamSse(
      {
        data: {
          model: 'deepseek-chat',
          stream: false,
          tools: [
            {
              type: 'function',
              function: {
                name: 'exec_command'
              }
            }
          ]
        }
      },
      { requestId: 'req-deepseek-sse-tool' } as any
    );

    expect(wantsSse).toBe(true);
  });

  it('forces upstream SSE for text-tool transformed payloads even when tools array is absent', async () => {
    const tokenFile = await createDeepSeekTokenFile('sse-tool-text-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-sse-tool-text'),
      createPowResponse: jest.fn(async () => 'pow-sse-tool-text'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const wantsSse = (provider as any).wantsUpstreamSse(
      {
        data: {
          model: 'deepseek-chat',
          stream: false,
          prompt: '<<RCC_TOOL_CALLS_JSON\\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}\\nRCC_TOOL_CALLS_JSON',
          metadata: {
            deepseek: {
              textToolFallback: true
            }
          }
        }
      },
      { requestId: 'req-deepseek-sse-tool-text' } as any
    );

    expect(wantsSse).toBe(true);
  });

  it('applies camoufox fingerprint headers for deepseek alias', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-fp-'));
    tempDirs.push(tempHome);
    process.env.HOME = tempHome;
    process.env.RCC_HOME = path.join(tempHome, '.rcc');
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT = '1';
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE = '0';
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER = 'deepseek';

    const tokenDir = path.join(tempHome, '.rcc', 'auth');
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(path.join(tokenDir, 'deepseek-account-1.json'), JSON.stringify({ access_token: 'cf-token' }, null, 2) + '\n', 'utf8');

    const fpDir = path.join(tempHome, '.rcc', 'camoufox-fp');
    await fs.mkdir(fpDir, { recursive: true });
    await fs.writeFile(
      path.join(fpDir, 'rc-deepseek.1.json'),
      JSON.stringify({
        env: {
          CAMOU_CONFIG_1: JSON.stringify({
            'navigator.userAgent': 'Mozilla/5.0 Camoufox DeepSeek Test',
            'navigator.platform': 'Win32',
            'navigator.oscpu': 'Windows NT 10.0; Win64; x64'
          })
        }
      }),
      'utf8'
    );

    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-cf-1'),
      createPowResponse: jest.fn(async () => 'pow-cf-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            accountAlias: '1'
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    (provider as any).setRuntimeProfile({
      runtimeKey: 'deepseek-web.1',
      keyAlias: '1',
      providerId: 'deepseek-web',
      providerKey: 'deepseek-web.1.deepseek-chat',
      providerType: 'openai'
    });

    await provider.initialize();

    const finalizedHeaders = await (provider as any).finalizeRequestHeaders(
      {},
      {
        data: {
          prompt: 'hello fingerprint'
        }
      }
    );

    expect(finalizedHeaders['User-Agent']).toBe(DEEPSEEK_UPSTREAM_USER_AGENT);
    expect(finalizedHeaders['x-client-platform']).toBe('android');
    expect(finalizedHeaders['x-client-version']).toBe(DEEPSEEK_UPSTREAM_CLIENT_VERSION);
    expect(finalizedHeaders['Origin']).toBe('https://chat.deepseek.com');
    expect(finalizedHeaders['Referer']).toBe('https://chat.deepseek.com/');
    expect(fakeSessionPow.ensureChatSession).toHaveBeenCalledTimes(1);
    expect(fakeSessionPow.ensureChatSession.mock.calls[0]?.[0]?.['User-Agent']).toBe(DEEPSEEK_UPSTREAM_USER_AGENT);
  });

  it('drops session headers and refreshes chat session cache for deepseek-web requests', async () => {
    const tokenFile = await createDeepSeekTokenFile('session-isolation-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-isolated-1'),
      createPowResponse: jest.fn(async () => 'pow-isolated-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();

    const finalizedHeaders = await (provider as any).finalizeRequestHeaders(
      {
        session_id: 'sticky-session-id',
        conversation_id: 'sticky-conversation-id'
      },
      {
        data: {
          prompt: 'fresh session please'
        }
      }
    );

    expect(finalizedHeaders.session_id).toBeUndefined();
    expect(finalizedHeaders.conversation_id).toBeUndefined();
    expect(fakeSessionPow.cleanup).toHaveBeenCalledTimes(1);
    expect(fakeSessionPow.ensureChatSession).toHaveBeenCalledTimes(1);
    expect(fakeSessionPow.ensureChatSession.mock.calls[0]?.[0]?.session_id).toBeUndefined();
    expect(fakeSessionPow.ensureChatSession.mock.calls[0]?.[0]?.conversation_id).toBeUndefined();
  });

  it('ignores inbound chat_session_id and parent_message_id for deepseek-web compat body', async () => {
    const tokenFile = await createDeepSeekTokenFile('fresh-session-body-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-fresh-body-1'),
      createPowResponse: jest.fn(async () => 'pow-fresh-body-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();

    await (provider as any).finalizeRequestHeaders(
      {},
      {
        data: {
          prompt: 'fresh session body request'
        }
      }
    );

    const body = (provider as any).buildHttpRequestBody({
      data: {
        prompt: 'fresh session body request',
        chat_session_id: 'stale-session-id',
        parent_message_id: 'stale-parent-id',
        thinking_enabled: true,
        search_enabled: false
      }
    });

    expect(body.chat_session_id).toBe('session-fresh-body-1');
    expect(body.parent_message_id).toBeNull();
  });

  it('keeps text-emitted function_calls untouched in provider runtime postprocess', async () => {
    const tokenFile = await createDeepSeekTokenFile('harvest-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-harvest-1'),
      createPowResponse: jest.fn(async () => 'pow-harvest-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();

    const postprocessed = await (provider as any).postprocessResponse(
      {
        id: 'chatcmpl-deepseek-text-tool',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                '<function_calls>{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"mailbox.status","arguments":{"target":"finger-system-agent"}}}]}</function_calls>'
            }
          }
        ]
      },
      { requestId: 'req-deepseek-harvest' } as any
    );

    const firstChoice = (postprocessed as any)?.data?.choices?.[0] || (postprocessed as any)?.choices?.[0];
    expect(firstChoice?.finish_reason).toBe('stop');
    expect(firstChoice?.message?.tool_calls).toBeUndefined();
    expect(String(firstChoice?.message?.content || '')).toContain('<function_calls>');
  });

  it('forces upstream SSE for text-tool wrapper prompts even after tools are folded into prompt', async () => {
    const tokenFile = await createDeepSeekTokenFile('sse-tool-wrapper-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-sse-3'),
      createPowResponse: jest.fn(async () => 'pow-sse-3'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const wantsSse = (provider as any).wantsUpstreamSse(
      {
        data: {
          model: 'deepseek-chat',
          prompt: `<tool_call>\n{"name":"exec_command","arguments":{"cmd":"bash -lc 'pwd'"}}\n</tool_call>`,
          metadata: {
            deepseek: {
              toolProtocol: 'text'
            }
          },
          stream: false
        }
      },
      { requestId: 'req-deepseek-sse-tool-wrapper' } as any
    );

    expect(wantsSse).toBe(true);
  });

  it('uploads context file and prepends uploaded ref_file_id', async () => {
    const tokenFile = await createDeepSeekTokenFile('context-file-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-context-1'),
      createPowResponse: jest.fn(async (_headers, targetPath?: string) => targetPath === '/api/v0/file/upload_file' ? 'pow-upload-1' : 'pow-completion-1'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const postSpy = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { file: { file_id: 'file_ctx_1' } } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/upload_file'
      } as any);
    const getSpy = jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file_ctx_1', status: 'processed' }] } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=file_ctx_1'
      } as any);

    const request = {
      data: {
        prompt: 'Continue from the latest state in the attached context.',
        ref_file_ids: ['existing_file'],
        thinking_enabled: false,
        search_enabled: false,
        metadata: {
          deepseek: {
            contextFile: {
              enabled: true,
              filename: 'context',
              content: '# context\nhello\n',
              contentType: 'text/plain; charset=utf-8'
            }
          }
        }
      }
    };

    await (provider as any).finalizeRequestHeaders({}, request);
    const body = (provider as any).buildHttpRequestBody(request);
    const uploadBody = Buffer.from(postSpy.mock.calls[0]?.[1] ?? []).toString('utf8');

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(fakeSessionPow.createPowResponse).toHaveBeenCalledWith(expect.any(Object), '/api/v0/file/upload_file');
    expect(uploadBody).toContain('filename="context.txt"');
    expect(body.ref_file_ids).toEqual(['file_ctx_1', 'existing_file']);
  });

  it('extracts uploaded context file id from array-shaped upload response', async () => {
    const tokenFile = await createDeepSeekTokenFile('context-file-array-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-context-array'),
      createPowResponse: jest.fn(async (_headers, targetPath?: string) => targetPath === '/api/v0/file/upload_file' ? 'pow-upload-array' : 'pow-completion-array'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const postSpy = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file_ctx_array_1', status: 'uploaded' }] } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/upload_file'
      } as any);
    const getSpy = jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file_ctx_array_1', status: 'processed' }] } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=file_ctx_array_1'
      } as any);

    const request = {
      data: {
        prompt: 'Continue from the latest state in the attached context.',
        ref_file_ids: ['existing_file'],
        thinking_enabled: false,
        search_enabled: false,
        metadata: {
          deepseek: {
            contextFile: {
              enabled: true,
              filename: 'context',
              content: '# context\nhello\n',
              contentType: 'text/plain; charset=utf-8'
            }
          }
        }
      }
    };

    await (provider as any).finalizeRequestHeaders({}, request);
    const body = (provider as any).buildHttpRequestBody(request);

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(body.ref_file_ids).toEqual(['file_ctx_array_1', 'existing_file']);
  });

  it('extracts uploaded context file id from deeply nested mixed upload response', async () => {
    const tokenFile = await createDeepSeekTokenFile('context-file-nested-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-context-nested'),
      createPowResponse: jest.fn(async (_headers, targetPath?: string) => targetPath === '/api/v0/file/upload_file' ? 'pow-upload-nested' : 'pow-completion-nested'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const postSpy = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            biz_data: {
              items: [
                'ignored',
                { nested: [{ file: { file_id: 'file_ctx_nested_1', status: 'uploaded' } }] }
              ]
            }
          }
        },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/upload_file'
      } as any);
    const getSpy = jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file_ctx_nested_1', status: 'processed' }] } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=file_ctx_nested_1'
      } as any);

    const request = {
      data: {
        prompt: 'Continue from the latest state in the attached context.',
        ref_file_ids: ['existing_file'],
        thinking_enabled: false,
        search_enabled: false,
        metadata: {
          deepseek: {
            contextFile: {
              enabled: true,
              filename: 'context',
              content: '# context\nhello\n',
              contentType: 'text/plain; charset=utf-8'
            }
          }
        }
      }
    };

    await (provider as any).finalizeRequestHeaders({}, request);
    const body = (provider as any).buildHttpRequestBody(request);

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(body.ref_file_ids).toEqual(['file_ctx_nested_1', 'existing_file']);
  });

  it('waits for uploaded context file to become ready before using ref_file_id', async () => {
    const tokenFile = await createDeepSeekTokenFile('context-file-ready-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-context-ready'),
      createPowResponse: jest.fn(async (_headers, targetPath?: string) => targetPath === '/api/v0/file/upload_file' ? 'pow-upload-ready' : 'pow-completion-ready'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    const postSpy = jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { file: { file_id: 'file_ctx_ready_1' } } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/upload_file'
      } as any);
    const getSpy = jest.spyOn((provider as any).httpClient, 'get')
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file_ctx_ready_1', status: 'uploaded' }] } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=file_ctx_ready_1'
      } as any)
      .mockResolvedValueOnce({
        data: { code: 0, data: { biz_data: { files: [{ file_id: 'file_ctx_ready_1', status: 'processed' }] } } },
        status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=file_ctx_ready_1'
      } as any);

    const request = {
      data: {
        prompt: 'Continue from the latest state in the attached context.',
        ref_file_ids: ['existing_file'],
        thinking_enabled: false,
        search_enabled: false,
        metadata: {
          deepseek: {
            contextFile: {
              enabled: true,
              filename: 'context',
              content: '# context\nhello\n',
              contentType: 'text/plain; charset=utf-8'
            }
          }
        }
      }
    };

    await (provider as any).finalizeRequestHeaders({}, request);
    const body = (provider as any).buildHttpRequestBody(request);

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(body.ref_file_ids).toEqual(['file_ctx_ready_1', 'existing_file']);
  });

  it('fails fast when context upload fails', async () => {
    const tokenFile = await createDeepSeekTokenFile('context-file-fail-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-context-fail'),
      createPowResponse: jest.fn(async () => 'pow-any'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValueOnce({
      data: { code: 500, msg: 'boom' },
      status: 500, statusText: 'ERR', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/upload_file'
    } as any);

    await expect((provider as any).finalizeRequestHeaders({}, {
      data: {
        prompt: 'Continue from the latest state in the attached context.',
        thinking_enabled: false,
        search_enabled: false,
        metadata: {
          deepseek: {
            contextFile: {
              enabled: true,
              filename: 'context',
              content: '# context\nhello\n',
              contentType: 'text/plain; charset=utf-8'
            }
          }
        }
      }
    })).rejects.toMatchObject({ code: 'DEEPSEEK_FILE_UPLOAD_FAILED' });
  });

  it('fails fast on upload biz_code error instead of misclassifying it as missing file id', async () => {
    const tokenFile = await createDeepSeekTokenFile('context-file-bizcode-token');
    const fakeSessionPow: FakeSessionPow = {
      ensureChatSession: jest.fn(async () => 'session-context-bizcode'),
      createPowResponse: jest.fn(async () => 'pow-any'),
      cleanup: jest.fn(async () => {})
    };

    const provider = new TestDeepSeekHttpProvider(
      {
        type: 'deepseek-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'deepseek-web',
          baseUrl: 'https://chat.deepseek.com',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            apiKey: '',
            tokenFile
          }
        }
      } as unknown as OpenAIStandardConfig,
      deps,
      fakeSessionPow
    );

    await provider.initialize();
    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValueOnce({
      data: { code: 0, msg: '', data: { biz_code: 9, biz_msg: 'unsupported file type', biz_data: null } },
      status: 200, statusText: 'OK', headers: {}, url: 'https://chat.deepseek.com/api/v0/file/upload_file'
    } as any);

    await expect((provider as any).finalizeRequestHeaders({}, {
      data: {
        prompt: 'Continue from the latest state in the attached context.',
        thinking_enabled: false,
        search_enabled: false,
        metadata: {
          deepseek: {
            contextFile: {
              enabled: true,
              filename: 'context',
              content: '# context\nhello\n',
              contentType: 'text/plain; charset=utf-8'
            }
          }
        }
      }
    })).rejects.toMatchObject({
      code: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      message: expect.stringContaining('biz_code=9')
    });
  });
});
