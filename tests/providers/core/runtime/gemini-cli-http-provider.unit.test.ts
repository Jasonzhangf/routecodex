import { GeminiCLIHttpProvider } from '../../../../src/providers/core/runtime/gemini-cli-http-provider.js';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/providers/modules/pipeline/interfaces/pipeline-interfaces.js';
import { createHash } from 'node:crypto';
import {
  cacheAntigravitySessionSignature,
  lookupAntigravitySessionSignatureEntry,
  resetAntigravitySessionSignatureCachesForTests,
  warmupAntigravitySessionSignatureModule
} from '../../../../src/modules/llmswitch/bridge.js';

const baseConfig: OpenAIStandardConfig = {
  id: 'test-gemini-cli',
  config: {
    providerType: 'gemini-cli',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    endpoint: '/v1internal:generateContent',
    auth: {
      type: 'gemini-cli-oauth',
      apiKey: ''
    }
  }
} as unknown as OpenAIStandardConfig;

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;

function stableSid(raw: string): string {
  return `sid-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

describe('GeminiCLIHttpProvider basic behaviour', () => {
  test('uses v1internal endpoint defaults when endpoint is not explicitly configured', () => {
    const configWithoutEndpoint: OpenAIStandardConfig = {
      ...baseConfig,
      config: {
        ...(baseConfig.config as any),
        endpoint: undefined
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new GeminiCLIHttpProvider(configWithoutEndpoint, emptyDeps) as any;
    const endpoint = provider.getEffectiveEndpoint();

    expect(endpoint).toBe('/v1internal:generateContent');
    expect(
      provider.resolveRequestEndpoint({ action: 'streamGenerateContent' }, endpoint)
    ).toBe('/v1internal:streamGenerateContent?alt=sse');
  });

  test('falls back to service default baseUrl when configured baseUrl is malformed endpoint path', () => {
    const malformedConfig: OpenAIStandardConfig = {
      ...baseConfig,
      config: {
        ...(baseConfig.config as any),
        baseUrl: '/v1beta/models:generateContent'
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new GeminiCLIHttpProvider(malformedConfig, emptyDeps) as any;
    const resolvedBaseUrl = provider.getEffectiveBaseUrl();

    expect(resolvedBaseUrl).toBe('https://cloudcode-pa.googleapis.com');
  });

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

  test('preserves nested request container (provider does not flatten)', async () => {
    const provider = new GeminiCLIHttpProvider(baseConfig, emptyDeps);
    const processed = await (provider as any).preprocessRequest({
      model: 'gemini-3-pro-high',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
      },
      stream: true
    });

    expect(processed).toBeTruthy();
    expect((processed as any).request).toBeTruthy();
    expect(Array.isArray((processed as any).request?.contents)).toBe(true);
    expect((processed as any).contents).toBeUndefined();
    expect((processed as any).stream).toBeUndefined();
  });

  test('antigravity minimal compatibility: requestId in body + requestId/requestType as headers', async () => {
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
      expect((processed as any).requestType).toBeUndefined();
      expect((processed as any).userAgent).toBeUndefined();
      expect((processed as any).session_id).toBeUndefined();
      expect((processed as any).generationConfig).toBeUndefined();
      expect((processed as any).stream).toBeUndefined();

      const headers = await (provider as any).finalizeRequestHeaders({}, processed);
      expect(headers).toBeTruthy();
      expect(headers.requestId).toBe((processed as any).requestId);
      expect(headers.requestType).toBe('agent');
      const streamHeaders = (provider as any).applyStreamModeHeaders(headers, true);
      expect(streamHeaders.Accept).toBe('*/*');

      const body = (provider as any).buildHttpRequestBody(processed);
      expect(body).toBeTruthy();
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['model', 'request']));
      expect(typeof (body as any).requestId).toBe('string');
      expect((body as any).requestType).toBeUndefined();
      expect((body as any).userAgent).toBeUndefined();
      expect((body as any).request).toBeTruthy();
      expect((body as any).contents).toBeUndefined();
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

  test('antigravity requestType resolves to web_search in minimal mode for online/networking requests', async () => {
    const prevHeaderMode = process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
    const prevRccHeaderMode = process.env.RCC_ANTIGRAVITY_HEADER_MODE;
    process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = 'minimal';
    process.env.RCC_ANTIGRAVITY_HEADER_MODE = 'minimal';
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
        model: 'gemini-3-pro-high-online',
        tools: [{ function: { name: 'web_search' } }],
        contents: [{ role: 'user', parts: [{ text: 'search latest updates' }] }],
        stream: true
      });

      const headers = await (provider as any).finalizeRequestHeaders({}, processed);
      expect(headers.requestType).toBe('web_search');
      expect((processed as any).requestType).toBeUndefined();
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

  test('antigravity default contract: requestId/userAgent/requestType in JSON + minimal headers', async () => {
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
      expect((processed as any).sessionId).toBeUndefined();

      const headers = await (provider as any).finalizeRequestHeaders({}, processed);
      expect(headers.requestId).toBeUndefined();
      expect(headers.requestType).toBeUndefined();
      expect(typeof headers['User-Agent']).toBe('string');
      expect(headers['X-Goog-Api-Client']).toBeUndefined();
      expect(headers['Client-Metadata']).toBeUndefined();
      expect(headers['Accept-Encoding']).toBeUndefined();
      expect(headers['X-Goog-QuotaUser']).toBeUndefined();
      expect(headers['X-Client-Device-Id']).toBeUndefined();

      const body = (provider as any).buildHttpRequestBody(processed);
      expect(typeof (body as any).requestId).toBe('string');
      expect((body as any).requestType).toBe('agent');
      expect((body as any).userAgent).toBe('antigravity');
      expect((body as any).request).toBeTruthy();
      expect((body as any).contents).toBeUndefined();
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

  test('antigravity standard contract: headers minimal + JSON body keeps requestId/requestType', async () => {
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
      expect((processed as any).session_id).toBeUndefined();
      expect((processed as any).sessionId).toBeUndefined();
      expect((processed as any).stream).toBeUndefined();

      const headers = await (provider as any).finalizeRequestHeaders({}, processed);
      expect(headers).toBeTruthy();
      expect(headers.requestId).toBeUndefined();
      expect(headers.requestType).toBeUndefined();
      expect(headers['User-Agent']).toContain('antigravity/');
      expect(headers['X-Goog-Api-Client']).toBeUndefined();
      expect(headers['Client-Metadata']).toBeUndefined();
      expect(headers['Accept-Encoding']).toBeUndefined();
      const streamHeaders = (provider as any).applyStreamModeHeaders(headers, true);
      expect(streamHeaders.Accept).toBe('text/event-stream');

      const body = (provider as any).buildHttpRequestBody(processed);
      expect(body).toBeTruthy();
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['model', 'request']));
      expect(typeof (body as any).requestId).toBe('string');
      expect((body as any).requestType).toBe('agent');
      expect((body as any).userAgent).toBe('antigravity');
      expect((body as any).request).toBeTruthy();
      expect((body as any).contents).toBeUndefined();
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

  test('antigravity default mode sets requestType=web_search for online model when missing', async () => {
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
        model: 'gemini-3-pro-high-online',
        contents: [{ role: 'user', parts: [{ text: 'search web' }] }],
        stream: true
      });

      expect((processed as any).requestType).toBe('web_search');
      const body = (provider as any).buildHttpRequestBody(processed);
      expect((body as any).requestType).toBe('web_search');
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

  test('antigravity transport keeps model id unchanged (no provider-side downgrade/fallback)', async () => {
    const cfg: OpenAIStandardConfig = {
      ...baseConfig,
      config: {
        ...(baseConfig.config as any),
        providerId: 'antigravity'
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new GeminiCLIHttpProvider(cfg, emptyDeps);
    const model = 'gemini-3-pro-low-online';
    const processed = await (provider as any).preprocessRequest({
      model,
      contents: [{ role: 'user', parts: [{ text: 'search web' }] }],
      stream: true
    });

    expect((processed as any).model).toBe(model);
    const body = (provider as any).buildHttpRequestBody(processed);
    expect((body as any).model).toBe(model);
  });

  test('antigravity thoughtSignature session swap: reuse alias signature sessionId when available', async () => {
    await warmupAntigravitySessionSignatureModule();
    resetAntigravitySessionSignatureCachesForTests();

    const cfg: OpenAIStandardConfig = {
      ...baseConfig,
      config: {
        ...(baseConfig.config as any),
        providerId: 'antigravity'
      }
    } as unknown as OpenAIStandardConfig;

    const aliasKey = 'antigravity.sessionSwap';
    const signatureSessionId = stableSid('session-1');
    cacheAntigravitySessionSignature(aliasKey, signatureSessionId, `EiYK${'a'.repeat(80)}`, 1);
    const probe = lookupAntigravitySessionSignatureEntry(aliasKey, stableSid('session-2'), { hydrate: false });
    expect(probe.source).toBe('miss');
    expect(probe.sourceSessionId).toBeUndefined();

    const provider = new GeminiCLIHttpProvider(cfg, emptyDeps);
    (provider as any).lastRuntimeMetadata = {
      runtimeKey: aliasKey,
      providerKey: `${aliasKey}.gemini-3-pro-high`,
      providerId: 'antigravity'
    };

    const processed = await (provider as any).preprocessRequest({
      model: 'gemini-3-pro-high',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      metadata: { user_id: 'user-2' },
      stream: true
    });

    // Provider swaps the sessionId to the one that has a cached thoughtSignature for this alias,
    // then restores it after the request (runtime metadata).
    expect((processed as any)?.metadata?.antigravitySessionId).toBe(signatureSessionId);
    expect((processed as any)?.metadata?.antigravitySessionIdOriginal).toBe('user-2');
  });

  test('antigravity sessionId derivation: ignores metadata.sessionId and uses derived fingerprint', async () => {
    await warmupAntigravitySessionSignatureModule();
    resetAntigravitySessionSignatureCachesForTests();

    const cfg: OpenAIStandardConfig = {
      ...baseConfig,
      config: {
        ...(baseConfig.config as any),
        providerId: 'antigravity'
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new GeminiCLIHttpProvider(cfg, emptyDeps);
    (provider as any).lastRuntimeMetadata = {
      runtimeKey: 'antigravity.sessionDerive',
      providerKey: 'antigravity.sessionDerive.gemini-3-pro-high',
      providerId: 'antigravity'
    };

    const seedText = 'session seed: provider should derive session id from user text parts';
    const expectedDerived = stableSid(seedText);

    const processed = await (provider as any).preprocessRequest({
      model: 'gemini-3-pro-high',
      contents: [{ role: 'user', parts: [{ text: seedText }] }],
      metadata: { sessionId: 'external-session-id' },
      stream: true
    });

    expect((processed as any)?.metadata?.antigravitySessionId).toBe(expectedDerived);
    expect((processed as any)?.metadata?.antigravitySessionIdOriginal).toBeUndefined();
  });

});
