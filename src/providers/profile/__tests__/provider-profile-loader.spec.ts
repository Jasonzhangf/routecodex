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

  it('maps responses aliases with api key auth', () => {
    const config: Record<string, unknown> = {
      providers: {
        responsesProxy: {
          type: 'responses-http-provider',
          baseUrl: 'https://proxy.example.com/v1',
          auth: {
            type: 'apikey',
            apiKey: '${RESPONSES_API_KEY}'
          },
          compatibilityProfile: 'responses:crs'
        }
      }
    };

    const result = buildProviderProfiles(config);
    const profile = result.byId.responsesProxy;
    expect(profile.protocol).toBe('responses');
    expect(profile.auth.kind).toBe('apikey');
    if (profile.auth.kind === 'apikey') {
      expect(profile.auth.apiKey).toBe('${RESPONSES_API_KEY}');
    }
    expect(profile.compatibilityProfile).toEqual('responses:crs');
  });

  it('rejects removed oauth auth config', () => {
    const config: Record<string, unknown> = {
      providers: {
        responsesProxy: {
          type: 'responses-http-provider',
          auth: {
            type: 'oauth'
          }
        }
      }
    };

    expect(() => buildProviderProfiles(config)).toThrow(/OAuth auth has been removed/);
  });

  it('rejects removed deepseek provider type', () => {
    const config: Record<string, unknown> = {
      providers: {
        deepseek: {
          type: 'deepseek'
        }
      }
    };

    expect(() => buildProviderProfiles(config)).toThrow(/unsupported type "deepseek"/i);
  });

  it('extracts transport backend from provider config', () => {
    const config: Record<string, unknown> = {
      providers: {
        tabglm: {
          type: 'anthropic',
          baseUrl: 'https://api.tabcode.cc/claude/glm',
          transportBackend: 'vercel-ai-sdk',
          auth: {
            type: 'x-api-key',
            apiKey: '${TABGLM_API_KEY}'
          }
        }
      }
    };

    const result = buildProviderProfiles(config);
    expect(result.byId.tabglm.transport.backend).toBe('vercel-ai-sdk');
  });

  it('maps mimoweb provider type to anthropic protocol and preserves module type', () => {
    const config: Record<string, unknown> = {
      providers: {
        mimoweb: {
          type: 'mimoweb',
          baseUrl: 'https://aistudio.xiaomimimo.com',
          auth: {
            type: 'apikey',
            apiKey: '',
            serviceToken: '${MIMO_SERVICE_TOKEN}',
            userId: '${MIMO_USER_ID}',
            phToken: '${MIMO_PH_TOKEN}'
          }
        }
      }
    };

    const result = buildProviderProfiles(config);
    expect(result.byId.mimoweb.protocol).toBe('anthropic');
    expect(result.byId.mimoweb.moduleType).toBe('mimoweb');
  });

  it('extracts concurrency and rpm metadata from provider config', () => {
    const config: Record<string, unknown> = {
      providers: {
        openai: {
          type: 'openai',
          concurrency: {
            maxInFlight: 1,
            acquireTimeoutMs: 45000,
            staleLeaseMs: 240000
          },
          rpm: {
            requestsPerMinute: 80,
            acquireTimeoutMs: 35000
          }
        }
      }
    };

    const result = buildProviderProfiles(config);
    expect(result.byId.openai.metadata?.concurrency).toEqual({
      maxInFlight: 1,
      acquireTimeoutMs: 45000,
      staleLeaseMs: 240000
    });
    expect(result.byId.openai.metadata?.rpm).toEqual({
      requestsPerMinute: 80,
      acquireTimeoutMs: 35000
    });
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

  it('rejects removed qwenchat provider type', () => {
    const config: Record<string, unknown> = {
      providers: {
        qwenchat: {
          type: 'qwenchat'
        }
      }
    };
    expect(() => buildProviderProfiles(config)).toThrow(/unsupported type \"qwenchat\"/i);
  });
});
