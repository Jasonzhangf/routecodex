import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { DeepSeekHttpProvider } from '../../../../src/providers/core/runtime/deepseek-http-provider.js';

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

  it('applies camoufox fingerprint headers for deepseek alias', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-fp-'));
    tempDirs.push(tempHome);
    process.env.HOME = tempHome;
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT = '1';
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE = '0';
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER = 'deepseek';

    const tokenDir = path.join(tempHome, '.routecodex', 'auth');
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(path.join(tokenDir, 'deepseek-account-1.json'), JSON.stringify({ access_token: 'cf-token' }, null, 2) + '\n', 'utf8');

    const fpDir = path.join(tempHome, '.routecodex', 'camoufox-fp');
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

    expect(finalizedHeaders['User-Agent']).toBe('Mozilla/5.0 Camoufox DeepSeek Test');
    expect(finalizedHeaders['x-client-platform']).toBe('windows');
    expect(finalizedHeaders['Origin']).toBe('https://chat.deepseek.com');
    expect(finalizedHeaders['Referer']).toBe('https://chat.deepseek.com/');
    expect(fakeSessionPow.ensureChatSession).toHaveBeenCalledTimes(1);
    expect(fakeSessionPow.ensureChatSession.mock.calls[0]?.[0]?.['User-Agent']).toBe('Mozilla/5.0 Camoufox DeepSeek Test');
  });
});
