import { describe, expect, test } from '@jest/globals';
import { ProviderFactory } from '../../src/providers/core/runtime/provider-factory.js';

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
        sessionReuseTtlMs: 120000
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
      textToolFallback: false,
      powTimeoutMs: 5000,
      powMaxAttempts: 3,
      sessionReuseTtlMs: 120000
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
});
