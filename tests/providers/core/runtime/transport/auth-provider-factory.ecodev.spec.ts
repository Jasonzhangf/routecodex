import { describe, expect, test } from '@jest/globals';
import { ApiKeyAuthProvider } from '../../../../../src/providers/auth/apikey-auth.js';
import { TokenFileAuthProvider } from '../../../../../src/providers/auth/tokenfile-auth.js';
import { createTransportAuthProvider } from '../../../../../src/providers/core/runtime/provider-bootstrap-utils.js';
import { AuthProviderFactory } from '../../../../../src/providers/core/runtime/transport/auth-provider-factory.js';

describe('AuthProviderFactory EcoDev OAuth token-file mode', () => {
  test('creates TokenFileAuthProvider for ecodev-oauth without OAuth client credentials', () => {
    const factory = new AuthProviderFactory({
      providerType: 'openai',
      moduleType: 'openai-http-provider',
      config: {
        config: {
          providerId: 'ecodev',
          auth: {
            type: 'ecodev-oauth',
            rawType: 'ecodev-oauth',
            tokenFile: '~/.rcc/auth/ecodev-oauth-1-default.json'
          } as any
        }
      },
      serviceProfile: {
        defaultBaseUrl: 'https://cn.devecostudio.huawei.com/sse/codeGenie/maas',
        defaultEndpoint: '/v2/chat/completions',
        defaultModel: 'GLM-5.1',
        requiredAuth: [],
        optionalAuth: ['oauth']
      } as any
    });

    expect(factory.createAuthProvider()).toBeInstanceOf(TokenFileAuthProvider);
  });

  test('prefers tokenFile mode for ecodev-oauth even when default OAuth fields are present', () => {
    const factory = new AuthProviderFactory({
      providerType: 'openai',
      moduleType: 'openai-http-provider',
      config: {
        config: {
          providerId: 'ecodev',
          auth: {
            type: 'ecodev-oauth',
            rawType: 'ecodev-oauth',
            tokenFile: '~/.rcc/auth/ecodev-oauth-1-default.json',
            clientId: '1008',
            tokenUrl: 'https://example.invalid/token',
            deviceCodeUrl: 'https://example.invalid/device'
          } as any
        }
      },
      serviceProfile: {
        defaultBaseUrl: 'https://cn.devecostudio.huawei.com/sse/codeGenie/maas',
        defaultEndpoint: '/v2/chat/completions',
        defaultModel: 'GLM-5.1',
        requiredAuth: [],
        optionalAuth: ['oauth']
      } as any
    });

    expect(factory.createAuthProvider()).toBeInstanceOf(TokenFileAuthProvider);
  });

  test('passes transport auth bootstrap validation for ecodev-oauth', () => {
    const result = createTransportAuthProvider({
      providerType: 'openai',
      moduleType: 'openai-http-provider',
      serviceProfile: {
        defaultBaseUrl: 'https://cn.devecostudio.huawei.com/sse/codeGenie/maas',
        defaultEndpoint: '/v2/chat/completions',
        defaultModel: 'GLM-5.1',
        requiredAuth: [],
        optionalAuth: ['oauth']
      } as any,
      config: {
        type: 'openai-http-provider',
        name: 'ecodev',
        config: {
          providerType: 'openai',
          providerId: 'ecodev',
          auth: {
            type: 'ecodev-oauth',
            rawType: 'ecodev-oauth',
            tokenFile: '~/.rcc/auth/ecodev-oauth-1-default.json'
          } as any
        }
      } as any
    });

    expect(result.oauthProviderId).toBe('ecodev');
    expect(result.authProvider).toBeInstanceOf(TokenFileAuthProvider);
  });

  test('creates ApiKeyAuthProvider with priority multi-key semantics when selectionMode=priority', async () => {
    const factory = new AuthProviderFactory({
      providerType: 'responses',
      moduleType: 'openai-http-provider',
      config: {
        config: {
          providerId: 'asxs',
          auth: {
            type: 'apikey',
            selectionMode: 'priority',
            entries: [
              { alias: 'primary', apiKey: 'sk-priority-key-1' },
              { alias: 'backup', apiKey: 'sk-priority-key-2' }
            ]
          } as any
        }
      },
      serviceProfile: {
        defaultBaseUrl: 'https://api.asxs.top/v1',
        defaultEndpoint: '/responses',
        defaultModel: 'gpt-5.4',
        requiredAuth: ['apikey'],
        optionalAuth: []
      } as any
    });

    const provider = factory.createAuthProvider();
    expect(provider).toBeInstanceOf(ApiKeyAuthProvider);
    await (provider as ApiKeyAuthProvider).initialize();
    expect((provider as ApiKeyAuthProvider).buildHeaders().Authorization).toBe('Bearer sk-priority-key-1');
    expect((provider as ApiKeyAuthProvider).buildHeaders().Authorization).toBe('Bearer sk-priority-key-1');
    expect((provider as ApiKeyAuthProvider).rotateKey()).toBe(true);
    expect((provider as ApiKeyAuthProvider).buildHeaders().Authorization).toBe('Bearer sk-priority-key-2');
  });
});
