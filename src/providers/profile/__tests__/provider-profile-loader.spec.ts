import { buildProviderProfiles } from '../provider-profile-loader.js';

describe('provider-profile-loader', () => {
  it('normalizes openai-like providers to openai protocol', () => {
    const config: Record<string, unknown> = {
      providers: {
        glm: {
          type: 'glm',
          baseUrl: 'https://glm.example.com',
          apiKey: '${GLM_KEY}',
          compatibilityProfile: 'chat:glm',
          headers: {
            'X-Test': 'demo'
          },
          timeout: 45000,
          retryAttempts: 2,
          models: {
            'glm-4': {},
            'glm-4.5': {}
          }
        }
      }
    };

    const result = buildProviderProfiles(config);
    expect(result.byId.glm).toBeDefined();
    expect(result.byId.glm.protocol).toBe('openai');
    expect(result.byId.glm.transport.baseUrl).toBe('https://glm.example.com');
    expect(result.byId.glm.auth.kind).toBe('apikey');
    expect(result.byId.glm.compatibilityProfile).toEqual('chat:glm');
    expect(result.byId.glm.metadata?.supportedModels).toEqual(['glm-4', 'glm-4.5']);
  });

  it('maps responses aliases and extracts oauth config', () => {
    const config: Record<string, unknown> = {
      providers: {
        responsesProxy: {
          type: 'responses-http-provider',
          baseUrl: 'https://proxy.example.com/v1',
          auth: {
            type: 'oauth',
            clientId: 'abc',
            clientSecret: 'secret',
            tokenUrl: 'https://proxy.example.com/oauth/token',
            authorizationUrl: 'https://proxy.example.com/oauth/authorize',
            scopes: ['responses.write']
          },
          compatibilityProfile: 'responses:c4m'
        }
      }
    };

    const result = buildProviderProfiles(config);
    const profile = result.byId.responsesProxy;
    expect(profile.protocol).toBe('responses');
    expect(profile.auth.kind).toBe('oauth');
    if (profile.auth.kind === 'oauth') {
      expect(profile.auth.clientId).toBe('abc');
      expect(profile.auth.scopes).toEqual(['responses.write']);
    }
    expect(profile.compatibilityProfile).toEqual('responses:c4m');
  });

  it('throws when legacy compatibility fields are used', () => {
    const config: Record<string, unknown> = {
      providers: {
        legacy: {
          type: 'glm',
          compat: 'old.compat'
        }
      }
    };
    expect(() => buildProviderProfiles(config)).toThrow(/legacy compatibility field/);
  });

  it('returns empty collection when providers are absent', () => {
    const config: Record<string, unknown> = {};
    const result = buildProviderProfiles(config);
    expect(result.profiles).toHaveLength(0);
    expect(result.byId).toEqual({});
  });
});
