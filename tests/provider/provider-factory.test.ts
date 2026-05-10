import { describe, expect, test } from '@jest/globals';
import { ProviderFactory } from '../../src/providers/core/runtime/provider-factory.js';
import { resolveProviderModule } from '../../src/providers/core/runtime/provider-factory-helpers.js';

describe('ProviderFactory no fallback', () => {
  test('clearInstanceCache drops active instance records', () => {
    const runtime: any = {
      runtimeKey: 'openai.cache.test',
      providerId: 'openai',
      providerType: 'openai',
      endpoint: 'https://api.openai.com/v1',
      auth: { type: 'apikey', value: 'sk-test-1234567890' }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any);
    expect(provider).toBeDefined();
    expect(ProviderFactory.getActiveInstances().size).toBeGreaterThanOrEqual(1);

    ProviderFactory.clearInstanceCache();
    expect(ProviderFactory.getActiveInstances().size).toBe(0);
  });

  test('unknown providerType/moduleType throws', () => {
    const cfg: any = { type: 'unknown-x', config: { providerType: 'unknown-y', auth: { type: 'apikey', apiKey: 'x' } } };
    expect(() => ProviderFactory.createProvider(cfg, { logger: {} as any } as any)).toThrow();
  });

  test('resolveProviderModule preserves canonical module names', () => {
    expect(resolveProviderModule('openai-http-provider')).toBe('openai-http-provider');
    expect(resolveProviderModule('responses-http-provider')).toBe('responses-http-provider');
    expect(resolveProviderModule('anthropic-http-provider')).toBe('anthropic-http-provider');
    expect(resolveProviderModule('gemini-http-provider')).toBe('gemini-http-provider');
    expect(resolveProviderModule('deepseek-http-provider')).toBe('deepseek-http-provider');
    expect(resolveProviderModule('mimoweb')).toBe('mimoweb-provider');
    expect(resolveProviderModule('mimoweb-provider')).toBe('mimoweb-provider');
    expect(resolveProviderModule('mock-provider')).toBe('mock-provider');
  });

  test('moduleType mimoweb-provider wins over generic anthropic providerType', () => {
    const runtime: any = {
      runtimeKey: 'mimoweb.key1',
      providerId: 'mimoweb',
      providerType: 'anthropic',
      providerModule: 'mimoweb-provider',
      endpoint: 'https://aistudio.xiaomimimo.com/api/chat',
      auth: {
        type: 'apikey',
        value: 'mimo-test-key'
      }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.type).toBe('mimoweb');
  });

  test('runtime timeoutMs/maxRetries map into provider config', () => {
    const runtime: any = {
      runtimeKey: 'nvidia.key1',
      providerId: 'nvidia',
      providerType: 'openai',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      auth: { type: 'apikey', value: '12345678901' },
      timeoutMs: 900000,
      maxRetries: 7
    };
    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.config?.config?.timeout).toBe(900000);
    expect(provider?.config?.config?.maxRetries).toBe(7);
  });

  test('deepseek account runtime maps into extensions and apikey auth payload', () => {
    const runtime: any = {
      runtimeKey: 'deepseek.key1',
      providerId: 'deepseek',
      providerFamily: 'deepseek',
      providerType: 'openai',
      compatibilityProfile: 'chat:deepseek-web',
      endpoint: 'https://chat.deepseek.com',
      deepseek: {
        strictToolRequired: true,
        textToolFallback: false,
        powTimeoutMs: 5000,
        powMaxAttempts: 3,
        sessionReuseTtlMs: 120000,
        contextFile: {
          enabled: true
        }
      },
      auth: {
        type: 'apikey',
        rawType: 'deepseek-account',
        value: '',
        tokenFile: '~/.routecodex/auth/deepseek-account-1.json'
      }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.type).toBe('deepseek-http-provider');
    expect(provider?.config?.config?.auth?.type).toBe('apikey');
    expect(provider?.config?.config?.auth?.rawType).toBe('deepseek-account');
    expect(provider?.config?.config?.auth?.apiKey).toBe('');
    expect(provider?.config?.config?.auth?.tokenFile).toBe('~/.routecodex/auth/deepseek-account-1.json');
    expect(provider?.config?.config?.extensions?.deepseek).toEqual({
      strictToolRequired: true,
      toolProtocol: 'native',
      powTimeoutMs: 5000,
      powMaxAttempts: 3,
      sessionReuseTtlMs: 120000,
      contextFileEnabled: true
    });
  });

  test('deepseek account runtime strips legacy inline fields and keeps tokenfile path', () => {
    const runtime: any = {
      runtimeKey: 'deepseek.legacy.1',
      providerId: 'deepseek',
      providerFamily: 'deepseek',
      providerType: 'openai',
      compatibilityProfile: 'chat:deepseek-web',
      endpoint: 'https://chat.deepseek.com',
      auth: {
        type: 'apikey',
        rawType: 'deepseek-account',
        value: 'legacy-inline-should-be-ignored',
        secretRef: 'deepseek-web.1',
        mobile: '18800000000',
        password: 'legacy-password',
        clientId: 'legacy-client-id',
        clientSecret: 'legacy-client-secret',
        tokenFile: '~/.routecodex/auth/deepseek-account-1.json',
        accountAlias: '1'
      }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.type).toBe('deepseek-http-provider');
    expect(provider?.config?.config?.auth?.rawType).toBe('deepseek-account');
    expect(provider?.config?.config?.auth?.apiKey).toBe('');
    expect(provider?.config?.config?.auth?.tokenFile).toBe('~/.routecodex/auth/deepseek-account-1.json');
    expect(provider?.config?.config?.auth?.accountAlias).toBe('1');
  });

  test('opencode zen-free placeholder key should normalize to public key mode', () => {
    const runtime: any = {
      runtimeKey: 'opencode-zen-free.key1',
      providerId: 'opencode-zen-free',
      providerType: 'openai',
      endpoint: 'https://opencode.ai/zen/v1',
      auth: {
        type: 'apikey',
        value: 'free-access-token'
      }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.config?.config?.auth?.type).toBe('apikey');
    expect(provider?.config?.config?.auth?.apiKey).toBe('public');
    expect(provider?.config?.config?.auth?.rawType).toBe('opencode-zen-public');
  });

  test('opencode zen-free missing key should normalize to public key mode', () => {
    const runtime: any = {
      runtimeKey: 'opencode-zen-free.key1',
      providerId: 'opencode-zen-free',
      providerType: 'openai',
      endpoint: 'https://opencode.ai/zen/v1',
      auth: {
        type: 'apikey',
        value: ''
      }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.config?.config?.auth?.apiKey).toBe('public');
    expect(provider?.config?.config?.auth?.rawType).toBe('opencode-zen-public');
  });

  test('opencode zen-free explicit public key should preserve public key mode', () => {
    const runtime: any = {
      runtimeKey: 'opencode-zen-free.key1',
      providerId: 'opencode-zen-free',
      providerType: 'openai',
      endpoint: 'https://opencode.ai/zen/v1',
      auth: {
        type: 'apikey',
        value: 'public'
      }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.config?.config?.auth?.apiKey).toBe('public');
    expect(provider?.config?.config?.auth?.rawType).toBe('opencode-zen-public');
  });

  test('generic deepseek openai gateway runtime should stay on openai provider', () => {
    ProviderFactory.clearInstanceCache();
    const runtime: any = {
      runtimeKey: 'deepseek.generic.key1',
      providerId: 'deepseek',
      providerFamily: 'deepseek',
      providerType: 'openai',
      providerKey: 'deepseek.key1.deepseek-v4-flash',
      endpoint: 'https://gateway.kevinllm.v6.army/v1/chat/completions',
      auth: {
        type: 'apikey',
        value: 'sk-test-generic-deepseek'
      }
    };

    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.type).toBe('openai-standard');
    expect(provider?.config?.config?.providerType).toBe('openai');
    expect(provider?.config?.config?.baseUrl).toBe('https://gateway.kevinllm.v6.army/v1/chat/completions');
    expect(provider?.getEffectiveEndpoint?.()).toBe('/chat/completions');
  });
});
