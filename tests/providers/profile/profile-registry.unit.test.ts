import { describe, expect, test } from '@jest/globals';
import { getProviderFamilyProfile, hasProviderFamilyProfile } from '../../../src/providers/profile/profile-registry.js';

describe('provider family profile registry', () => {
  test('resolves responses/anthropic profiles from providerType', () => {
    const responsesProfile = getProviderFamilyProfile({ providerType: 'responses' });
    const anthropicProfile = getProviderFamilyProfile({ providerType: 'anthropic' });

    expect(responsesProfile?.providerFamily).toBe('responses');
    expect(anthropicProfile?.providerFamily).toBe('anthropic');
    expect(hasProviderFamilyProfile({ providerType: 'responses' })).toBe(true);
    expect(hasProviderFamilyProfile({ providerType: 'anthropic' })).toBe(true);
  });

  test('resolves glm/qwen profiles from providerId', () => {
    const glmProfile = getProviderFamilyProfile({ providerId: 'glm' });
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });

    expect(glmProfile?.providerFamily).toBe('glm');
    expect(qwenProfile?.providerFamily).toBe('qwen');
    expect(hasProviderFamilyProfile({ providerId: 'glm' })).toBe(true);
    expect(hasProviderFamilyProfile({ providerId: 'qwen' })).toBe(true);
  });

  test('responses profile enforces codex UA header policy', () => {
    const profile = getProviderFamilyProfile({ providerType: 'responses' });
    expect(profile).toBeTruthy();

    const untouched = profile?.applyRequestHeaders?.({
      headers: {
        'User-Agent': 'curl/8.7.1'
      },
      isCodexUaMode: false
    });
    expect(untouched).toBeUndefined();

    const adjusted = profile?.applyRequestHeaders?.({
      headers: {
        'User-Agent': 'curl/8.7.1'
      },
      isCodexUaMode: true
    });

    expect(adjusted?.['User-Agent']).toContain('codex_cli_rs/0.73.0');
    expect(adjusted?.originator).toBe('codex_cli_rs');
  });

  test('anthropic profile derives stream intent and prepares stream body', () => {
    const profile = getProviderFamilyProfile({ providerType: 'anthropic' });
    expect(profile).toBeTruthy();

    const fromContext = profile?.resolveStreamIntent?.({
      request: { stream: false } as any,
      context: { metadata: { stream: true } } as any
    });
    expect(fromContext).toBe(true);

    const fromRequest = profile?.resolveStreamIntent?.({
      request: { stream: true } as any,
      context: { metadata: {} } as any
    });
    expect(fromRequest).toBe(true);

    const defaultFalse = profile?.resolveStreamIntent?.({
      request: {} as any,
      context: { metadata: {} } as any
    });
    expect(defaultFalse).toBe(false);

    const body: Record<string, unknown> = {};
    profile?.prepareStreamBody?.({
      body,
      context: {} as any
    });
    expect(body.stream).toBe(true);
  });

  test('glm profile trims assistant non-string content in request body', () => {
    const profile = getProviderFamilyProfile({ providerId: 'glm' });
    expect(profile).toBeTruthy();

    const output = profile?.buildRequestBody?.({
      request: {
        model: 'glm-4.7',
        messages: []
      } as any,
      defaultBody: {
        model: 'glm-4.7',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: { foo: 'bar' } },
          { role: 'assistant', content: null }
        ]
      } as any
    }) as any;

    expect(output.messages[1].content).toBe('{"foo":"bar"}');
    expect(output.messages[2].content).toBe('');
  });

  test('resolves antigravity profile and applies header/ua contracts', async () => {
    const previousUa = process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT;
    process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT = 'antigravity/9.9.9 windows/amd64';

    try {
      const profile = getProviderFamilyProfile({ providerId: 'antigravity' });
      expect(profile).toBeTruthy();
      expect(profile?.providerFamily).toBe('antigravity');
      expect(hasProviderFamilyProfile({ providerId: 'antigravity' })).toBe(true);

      const resolvedUa = await profile?.resolveUserAgent?.({
        defaultUserAgent: 'routecodex/default',
        runtimeMetadata: {
          runtimeKey: 'antigravity.test',
          providerKey: 'antigravity.test.gemini-3-pro-high'
        } as any
      });
      expect(resolvedUa).toBe('antigravity/9.9.9 windows/amd64');

      const previousHeaderMode = process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
      process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = 'minimal';
      try {
        const adjusted = profile?.applyRequestHeaders?.({
          headers: {
            'X-Goog-Api-Client': 'foo',
            'Client-Metadata': 'bar',
            'Accept-Encoding': 'gzip',
            originator: 'codex_cli_rs'
          },
          request: {
            requestId: 'agent-123',
            metadata: { hasImageAttachment: true }
          } as any
        });

        expect(adjusted?.['X-Goog-Api-Client']).toBeUndefined();
        expect(adjusted?.['Client-Metadata']).toBeUndefined();
        expect(adjusted?.['Accept-Encoding']).toBeUndefined();
        expect(adjusted?.originator).toBeUndefined();
        expect(adjusted?.requestId).toBe('agent-123');
        expect(adjusted?.requestType).toBe('image_gen');

        const adjustedWebSearch = profile?.applyRequestHeaders?.({
          headers: {},
          request: {
            model: 'gemini-3-pro-high-online',
            tools: [{ function: { name: 'web_search' } }]
          } as any
        });
        expect(adjustedWebSearch?.requestType).toBe('web_search');

        const streamHeaders = profile?.applyStreamModeHeaders?.({
          headers: { Accept: 'text/event-stream' },
          wantsSse: true
        } as any);
        expect(streamHeaders?.Accept).toBe('*/*');
      } finally {
        if (previousHeaderMode === undefined) {
          delete process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE;
        } else {
          process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE = previousHeaderMode;
        }
      }
    } finally {
      if (previousUa === undefined) {
        delete process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT;
      } else {
        process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT = previousUa;
      }
    }
  });

  test('qwen profile decides OAuth token-file mode', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });

    expect(
      qwenProfile?.resolveOAuthTokenFileMode?.({
        oauthProviderId: 'qwen',
        auth: {},
        moduleType: 'openai-http-provider'
      })
    ).toBe(true);

    expect(
      qwenProfile?.resolveOAuthTokenFileMode?.({
        oauthProviderId: 'qwen',
        auth: { clientId: 'qwen-client' },
        moduleType: 'openai-http-provider'
      })
    ).toBe(false);
  });

  test('qwen profile applies DashScope headers and removes legacy Gemini metadata headers', () => {
    const previousUaVersion = process.env.ROUTECODEX_QWEN_UA_VERSION;
    process.env.ROUTECODEX_QWEN_UA_VERSION = '0.14.3';

    try {
      const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
      expect(qwenProfile).toBeTruthy();

      const headers = qwenProfile?.applyRequestHeaders?.({
        headers: {
          Authorization: 'Bearer sk-qwen-test-token',
          'User-Agent': 'curl/8.7.1',
          'X-DashScope-UserAgent': 'curl/8.7.1',
          originator: 'codex-tui',
          session_id: 'session-from-client',
          conversation_id: 'conversation-from-client',
          'X-Goog-Api-Client': 'gl-node/22.17.0',
          'Client-Metadata': 'legacy'
        }
      } as any);

      expect(headers?.['X-Goog-Api-Client']).toBeUndefined();
      expect(headers?.['Client-Metadata']).toBeUndefined();
      expect(headers?.['X-DashScope-CacheControl']).toBe('enable');
      expect(headers?.['X-DashScope-AuthType']).toBe('qwen-oauth');
      expect(headers?.['User-Agent']).toBe('QwenCode/0.14.3 (darwin; arm64)');
      expect(headers?.['X-DashScope-UserAgent']).toBe(headers?.['User-Agent']);
      expect(headers?.['X-Stainless-Lang']).toBe('js');
      expect(headers?.['X-Stainless-Runtime']).toBe('node');
      expect(headers?.['X-Stainless-Runtime-Version']).toBe(process.version);
      expect(headers?.['X-Stainless-Package-Version']).toBe('5.11.0');
      expect(headers?.['X-Stainless-OS']).toBe('MacOS');
      expect(headers?.['X-Stainless-Retry-Count']).toBe('0');
      expect(headers?.['X-Stainless-Os']).toBeUndefined();
      expect(headers?.originator).toBeUndefined();
      expect(headers?.session_id).toBeUndefined();
      expect(headers?.conversation_id).toBeUndefined();
    } finally {
      if (previousUaVersion === undefined) {
        delete process.env.ROUTECODEX_QWEN_UA_VERSION;
      } else {
        process.env.ROUTECODEX_QWEN_UA_VERSION = previousUaVersion;
      }
    }
  });

  test('qwen profile resolveUserAgent ignores client/config passthrough and stays qwen-cli aligned', () => {
    const previousUaVersion = process.env.ROUTECODEX_QWEN_UA_VERSION;
    process.env.ROUTECODEX_QWEN_UA_VERSION = '0.14.3';

    try {
      const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
      expect(qwenProfile).toBeTruthy();

      const resolved = qwenProfile?.resolveUserAgent?.({
        uaFromConfig: 'curl/8.7.1',
        uaFromService: 'custom-service/1.0',
        inboundUserAgent: 'codex-tui/0.118.0',
        defaultUserAgent: 'RouteCodex/2.0'
      } as any);

      expect(resolved).toBe('QwenCode/0.14.3 (darwin; arm64)');
    } finally {
      if (previousUaVersion === undefined) {
        delete process.env.ROUTECODEX_QWEN_UA_VERSION;
      } else {
        process.env.ROUTECODEX_QWEN_UA_VERSION = previousUaVersion;
      }
    }
  });

  test('qwen profile remaps oauth request model to coder-model', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
    expect(qwenProfile).toBeTruthy();

    const body = qwenProfile?.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      defaultBody: {
        model: 'qwen3.5-plus',
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      runtimeMetadata: {
        authType: 'qwen-oauth'
      } as any
    } as any);

    expect((body as any)?.model).toBe('coder-model');
    expect((body as any)?.vl_high_resolution_images).toBe(true);
    expect((body as any)?.messages?.[0]?.role).toBe('system');
    expect((body as any)?.messages?.[0]?.content).toEqual([
      {
        type: 'text',
        text: '',
        cache_control: { type: 'ephemeral' }
      }
    ]);
    expect((body as any)?.reasoning_effort).toBeUndefined();
  });

  test('qwen profile keeps oauth vision requests on coder-model per official qwen code', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
    expect(qwenProfile).toBeTruthy();

    const body = qwenProfile?.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      defaultBody: {
        model: 'qwen-vl-max',
        messages: [{ role: 'user', content: 'describe this image' }]
      } as any,
      runtimeMetadata: {
        authType: 'qwen-oauth'
      } as any
    } as any);

    expect((body as any)?.model).toBe('coder-model');
    expect((body as any)?.vl_high_resolution_images).toBe(true);
  });

  test('qwen profile merges user system messages into injected qwen-oauth system envelope', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
    expect(qwenProfile).toBeTruthy();

    const body = qwenProfile?.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      defaultBody: {
        model: 'qwen3.5-plus',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'hello' },
          { role: 'system', content: [{ type: 'text', text: 'Keep markdown.' }] }
        ]
      } as any,
      runtimeMetadata: {
        authType: 'qwen-oauth'
      } as any
    } as any);

    expect((body as any)?.model).toBe('coder-model');
    expect((body as any)?.messages?.[0]?.role).toBe('system');
    expect((body as any)?.messages?.[0]?.content).toEqual([
      {
        type: 'text',
        text: '',
        cache_control: { type: 'ephemeral' }
      },
      { type: 'text', text: 'Be concise.' },
      { type: 'text', text: 'Keep markdown.', cache_control: { type: 'ephemeral' } }
    ]);
    expect((body as any)?.messages?.[1]).toEqual({ role: 'user', content: 'hello' });
    expect((body as any)?.messages).toHaveLength(2);
  });

  test('qwen profile mirrors reasoning.effort into reasoning_effort for oauth requests', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
    expect(qwenProfile).toBeTruthy();

    const body = qwenProfile?.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      defaultBody: {
        model: 'qwen3.6-plus',
        reasoning: { effort: 'high', summary: 'detailed' },
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      runtimeMetadata: {
        authType: 'qwen-oauth'
      } as any
    } as any);

    expect((body as any)?.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    expect((body as any)?.reasoning_effort).toBe('high');
  });

  test('qwen profile keeps non-oauth model unchanged', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
    expect(qwenProfile).toBeTruthy();

    const body = qwenProfile?.buildRequestBody?.({
      request: {
        metadata: { authType: 'apikey' }
      } as any,
      defaultBody: {
        model: 'qwen3.5-plus',
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      runtimeMetadata: {
        authType: 'apikey'
      } as any
    } as any);

    expect(body).toBeUndefined();
  });

  test('qwen profile resolves native web_search endpoint and body shape', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
    expect(qwenProfile).toBeTruthy();

    const endpoint = qwenProfile?.resolveEndpoint?.({
      request: {
        metadata: {
          qwenWebSearch: true,
          entryEndpoint: '/api/v1/indices/plugin/web_search'
        }
      } as any,
      defaultEndpoint: '/chat/completions'
    });
    expect(endpoint).toBe('/api/v1/indices/plugin/web_search');

    const body = qwenProfile?.buildRequestBody?.({
      request: {
        metadata: { qwenWebSearch: true },
        data: {
          uq: 'routecodex',
          page: 1,
          rows: 5
        }
      } as any,
      defaultBody: {
        model: 'qwen3.5-plus',
        messages: [{ role: 'user', content: 'ignored' }]
      } as any
    } as any);

    expect(body).toEqual({
      uq: 'routecodex',
      page: 1,
      rows: 5
    });
  });
});
