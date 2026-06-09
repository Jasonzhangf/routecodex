import { describe, expect, test } from '@jest/globals';
import { applyProviderProfileOverrides, updateProviderProfiles } from '../../../src/server/runtime/http-server/http-server-bootstrap.js';
import { ProviderFactory } from '../../../src/providers/core/runtime/provider-factory.js';
import type { ProviderRuntimeProfile } from '../../../src/providers/core/api/provider-types.js';

describe('http-server bootstrap provider profile overrides', () => {
  test('does not propagate profile autoRetry into runtime overrides', () => {
    const server = {
      providerProfileIndex: new Map<string, unknown>()
    } as any;

    updateProviderProfiles(server, undefined, {
      providers: {
        minimax: {
          type: 'openai',
          auth: {
            type: 'apikey',
            apiKey: '${MINIMAX_API_KEY}'
          },
          autoRetry: {
            threshold: 3,
            codes: ['0.8200']
          },
          models: ['MiniMax-M2.7']
        }
      }
    } as Record<string, unknown>);

    const runtime = {
      runtimeKey: 'minimax.key1',
      providerId: 'minimax',
      providerType: 'openai',
      providerKey: 'minimax.key1.MiniMax-M2.7',
      endpoint: 'https://api.minimax.chat/v1/chat/completions',
      auth: {
        type: 'apikey',
        value: 'sk-test-minimax'
      }
    } as unknown as ProviderRuntimeProfile;

    const patched = applyProviderProfileOverrides(server, runtime);
    expect((patched as any).autoRetry).toBeUndefined();
  });

  test('deepseek-web keeps implicit deepseek provider module when profile type is generic openai', () => {
    const server = {
      providerProfileIndex: new Map<string, unknown>()
    } as any;

    updateProviderProfiles(server, undefined, {
      providers: {
        'deepseek-web': {
          type: 'openai',
          auth: {
            type: 'apikey',
            rawType: 'deepseek-account',
            tokenFile: '~/.rcc/auth/deepseek-account-1.json'
          },
          compatibilityProfile: 'chat:deepseek-web',
          models: ['deepseek-chat', 'deepseek-reasoner']
        }
      }
    } as Record<string, unknown>);

    const runtime = {
      runtimeKey: 'deepseek-web.1',
      providerId: 'deepseek-web',
      providerType: 'openai',
      providerKey: 'deepseek-web.1.deepseek-reasoner',
      compatibilityProfile: 'chat:deepseek-web',
      endpoint: 'https://chat.deepseek.com/api/v0/chat/completions',
      auth: {
        type: 'apikey',
        rawType: 'deepseek-account',
        tokenFile: '~/.rcc/auth/deepseek-account-1.json'
      }
    } as unknown as ProviderRuntimeProfile;

    const patched = applyProviderProfileOverrides(server, runtime);

    expect(patched.providerType).toBe('openai');
    expect(patched.compatibilityProfile).toBe('chat:deepseek-web');
    expect(patched.providerModule).toBe('deepseek-http-provider');

    const provider = ProviderFactory.createProviderFromRuntime(patched, { logger: {} as any } as any) as any;
    expect(provider?.type).toBe('deepseek-http-provider');
  });

  test('generic deepseek api provider keeps openai module override', () => {
    const server = {
      providerProfileIndex: new Map<string, unknown>()
    } as any;

    updateProviderProfiles(server, undefined, {
      providers: {
        deepseek: {
          type: 'openai',
          auth: {
            type: 'apikey',
            apiKey: '${DEEPSEEK_API_KEY}'
          },
          models: ['deepseek-v4-pro-reasoner']
        }
      }
    } as Record<string, unknown>);

    const runtime = {
      runtimeKey: 'deepseek.key1',
      providerId: 'deepseek',
      providerType: 'openai',
      providerKey: 'deepseek.key1.deepseek-v4-pro-reasoner',
      endpoint: 'https://gateway.kevinllm.v6.army/v1/chat/completions',
      auth: {
        type: 'apikey',
        value: 'sk-test-generic-deepseek'
      }
    } as unknown as ProviderRuntimeProfile;

    const patched = applyProviderProfileOverrides(server, runtime);

    expect(patched.providerModule).toBe('openai');

    const provider = ProviderFactory.createProviderFromRuntime(patched, { logger: {} as any } as any) as any;
    expect(provider?.type).toBe('openai-standard');
  });
});
