import { GeminiCLIHttpProvider } from '../../../../src/providers/core/runtime/gemini-cli-http-provider.js';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/providers/modules/pipeline/interfaces/pipeline-interfaces.js';

const baseConfig: OpenAIStandardConfig = {
  id: 'test-gemini-cli',
  config: {
    providerType: 'gemini-cli',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    endpoint: '/v1internal:generateContent',
    extensions: {
      projectId: 'test-project'
    },
    auth: {
      type: 'gemini-cli-oauth',
      apiKey: ''
    }
  }
} as unknown as OpenAIStandardConfig;

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;

describe('GeminiCLIHttpProvider basic behaviour', () => {
  test('constructs and exposes service profile from config-core', () => {
    const provider = new GeminiCLIHttpProvider(baseConfig, emptyDeps);

    // getConfig() should reflect injected config, service profile should come from service-profiles
    const cfg = provider.getConfig() as Record<string, unknown>;
    expect(cfg).toBeTruthy();

    const profile = (provider as any).serviceProfile;
    expect(profile).toBeTruthy();
    expect(profile.defaultBaseUrl).toContain('cloudcode-pa.googleapis.com');
    expect(profile.defaultEndpoint).toContain('v1internal:generateContent');
    expect(profile.requiredAuth).toContain('oauth');
  });

  test('flattens accidental nested request container (avoid body.request.request.*)', async () => {
    const provider = new GeminiCLIHttpProvider(baseConfig, emptyDeps);
    const processed = await (provider as any).preprocessRequest({
      model: 'gemini-3-pro-high',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
      },
      stream: true
    });

    expect(processed).toBeTruthy();
    expect((processed as any).request).toBeUndefined();
    expect(Array.isArray((processed as any).contents)).toBe(true);
    expect((processed as any).stream).toBeUndefined();
  });

  test('antigravity compatibility: headerMode=minimal keeps requestId/requestType in JSON wrapper only', async () => {
    const prevHeaderMode = process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
    const prevRccHeaderMode = process.env.RCC_ANTIGRAVITY_HEADER_MODE;
    process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = 'minimal';
    process.env.RCC_ANTIGRAVITY_HEADER_MODE = 'minimal';
    const cfg: OpenAIStandardConfig = {
      ...baseConfig,
      config: {
        ...(baseConfig.config as any),
        providerId: 'antigravity'
      }
    } as unknown as OpenAIStandardConfig;

    try {
      const provider = new GeminiCLIHttpProvider(cfg, emptyDeps);
      const processed = await (provider as any).preprocessRequest({
        model: 'gemini-3-pro-high',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction: { role: 'system', parts: [{ text: 'custom-system' }] },
        stream: true
      });

      expect((processed as any).systemInstruction).toEqual(
        expect.objectContaining({ role: 'system' })
      );
      expect(typeof (processed as any).requestId).toBe('string');
      expect(String((processed as any).requestId)).toContain('agent-');
      expect((processed as any).requestType).toBe('agent');
      expect((processed as any).userAgent).toBe('antigravity');
      expect(typeof (processed as any).metadata?.__antigravityRequestId).toBe('string');
      expect(String((processed as any).metadata?.__antigravityRequestId)).toContain('agent-');
      expect((processed as any).metadata?.__antigravityRequestType).toBe('agent');
      expect((processed as any).session_id).toBeUndefined();
      expect((processed as any).generationConfig).toBeUndefined();
      expect((processed as any).stream).toBeUndefined();

      const headers = await (provider as any).finalizeRequestHeaders({}, processed);
      expect(headers).toBeTruthy();
      expect(headers.requestId).toBeUndefined();
      expect(headers.requestType).toBeUndefined();
      expect(typeof headers['User-Agent']).toBe('string');
      expect(headers['X-Goog-Api-Client']).toBeUndefined();
      expect(headers['Client-Metadata']).toBeUndefined();
      expect(headers['X-Goog-QuotaUser']).toBeUndefined();
      expect(headers['X-Client-Device-Id']).toBeUndefined();
      const streamHeaders = (provider as any).applyStreamModeHeaders(headers, true);
      expect(streamHeaders.Accept).toBe('text/event-stream');

      const body = (provider as any).buildHttpRequestBody(processed);
      expect(body).toBeTruthy();
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['model', 'request']));
      expect(typeof (body as any).requestId).toBe('string');
      expect((body as any).requestType).toBe('agent');
      expect((body as any).userAgent).toBe('antigravity');
    } finally {
      if (prevHeaderMode === undefined) {
        delete process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
      } else {
        process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = prevHeaderMode;
      }
      if (prevRccHeaderMode === undefined) {
        delete process.env.RCC_ANTIGRAVITY_HEADER_MODE;
      } else {
        process.env.RCC_ANTIGRAVITY_HEADER_MODE = prevRccHeaderMode;
      }
    }
  });

  test('antigravity default behaviour: standard-by-default (no env, headers minimal)', async () => {
    const prevHeaderMode = process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
    const prevRccHeaderMode = process.env.RCC_ANTIGRAVITY_HEADER_MODE;
    delete process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
    delete process.env.RCC_ANTIGRAVITY_HEADER_MODE;
    try {
      const cfg: OpenAIStandardConfig = {
        ...baseConfig,
        config: {
          ...(baseConfig.config as any),
          providerId: 'antigravity'
        }
      } as unknown as OpenAIStandardConfig;

      const provider = new GeminiCLIHttpProvider(cfg, emptyDeps);
      const processed = await (provider as any).preprocessRequest({
        model: 'gemini-3-pro-high',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        stream: true
      });

      expect(typeof (processed as any).requestId).toBe('string');
      expect(String((processed as any).requestId)).toContain('agent-');
      expect((processed as any).requestType).toBe('agent');
      expect((processed as any).userAgent).toBe('antigravity');
      expect(typeof (processed as any).metadata?.__antigravityRequestId).toBe('string');
      expect(String((processed as any).metadata?.__antigravityRequestId)).toContain('agent-');
      expect((processed as any).metadata?.__antigravityRequestType).toBe('agent');
      expect((processed as any).sessionId).toBeUndefined();

      const headers = await (provider as any).finalizeRequestHeaders({}, processed);
      expect(headers.requestId).toBeUndefined();
      expect(headers.requestType).toBeUndefined();
      expect(typeof headers['User-Agent']).toBe('string');
      expect(headers['X-Goog-Api-Client']).toBeUndefined();
      expect(headers['Client-Metadata']).toBeUndefined();
      expect(headers['X-Goog-QuotaUser']).toBeUndefined();
      expect(headers['X-Client-Device-Id']).toBeUndefined();

      const body = (provider as any).buildHttpRequestBody(processed);
      expect(typeof (body as any).requestId).toBe('string');
      expect((body as any).requestType).toBe('agent');
      expect((body as any).userAgent).toBe('antigravity');
      expect((body as any).request?.sessionId).toBeUndefined();
    } finally {
      if (prevHeaderMode === undefined) {
        delete process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
      } else {
        process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = prevHeaderMode;
      }
      if (prevRccHeaderMode === undefined) {
        delete process.env.RCC_ANTIGRAVITY_HEADER_MODE;
      } else {
        process.env.RCC_ANTIGRAVITY_HEADER_MODE = prevRccHeaderMode;
      }
    }
  });

  test('antigravity standard contract: headers minimal + JSON wrapper keeps requestId/requestType', async () => {
    const prevHeaderMode = process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
    const prevRccHeaderMode = process.env.RCC_ANTIGRAVITY_HEADER_MODE;
    process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = 'standard';
    process.env.RCC_ANTIGRAVITY_HEADER_MODE = 'standard';
    try {
      const cfg: OpenAIStandardConfig = {
        ...baseConfig,
        config: {
          ...(baseConfig.config as any),
          providerId: 'antigravity'
        }
      } as unknown as OpenAIStandardConfig;

      const provider = new GeminiCLIHttpProvider(cfg, emptyDeps);
      const processed = await (provider as any).preprocessRequest({
        model: 'gemini-3-pro-high',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction: { role: 'system', parts: [{ text: 'custom-system' }] },
        stream: true
      });

      expect((processed as any).systemInstruction).toEqual(
        expect.objectContaining({ role: 'system' })
      );
      expect(typeof (processed as any).requestId).toBe('string');
      expect(String((processed as any).requestId)).toContain('agent-');
      expect((processed as any).requestType).toBe('agent');
      expect((processed as any).userAgent).toBe('antigravity');
      expect(typeof (processed as any).metadata?.__antigravityRequestId).toBe('string');
      expect(String((processed as any).metadata?.__antigravityRequestId)).toContain('agent-');
      expect((processed as any).metadata?.__antigravityRequestType).toBe('agent');
      expect((processed as any).session_id).toBeUndefined();
      expect((processed as any).sessionId).toBeUndefined();
      expect((processed as any).stream).toBeUndefined();

      const headers = await (provider as any).finalizeRequestHeaders({}, processed);
      expect(headers).toBeTruthy();
      expect(headers.requestId).toBeUndefined();
      expect(headers.requestType).toBeUndefined();
      expect(typeof headers['User-Agent']).toBe('string');
      expect(headers['X-Goog-Api-Client']).toBeUndefined();
      expect(headers['Client-Metadata']).toBeUndefined();
      expect(headers['X-Goog-QuotaUser']).toBeUndefined();
      expect(headers['X-Client-Device-Id']).toBeUndefined();
      expect(headers.originator).toBeUndefined();
      const streamHeaders = (provider as any).applyStreamModeHeaders(headers, true);
      expect(streamHeaders.Accept).toBe('text/event-stream');

      const body = (provider as any).buildHttpRequestBody(processed);
      expect(body).toBeTruthy();
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['model', 'request']));
      expect(typeof (body as any).requestId).toBe('string');
      expect((body as any).requestType).toBe('agent');
      expect((body as any).userAgent).toBe('antigravity');
      expect((body as any).request?.sessionId).toBeUndefined();
    } finally {
      if (prevHeaderMode === undefined) {
        delete process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
      } else {
        process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = prevHeaderMode;
      }
      if (prevRccHeaderMode === undefined) {
        delete process.env.RCC_ANTIGRAVITY_HEADER_MODE;
      } else {
        process.env.RCC_ANTIGRAVITY_HEADER_MODE = prevRccHeaderMode;
      }
    }
  });
});
