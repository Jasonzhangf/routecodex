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

  test('resolves glm profile and no longer exposes qwen profile from providerId', () => {
    const glmProfile = getProviderFamilyProfile({ providerId: 'glm' });
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });

    expect(glmProfile?.providerFamily).toBe('glm');
    expect(qwenProfile).toBeUndefined();
    expect(hasProviderFamilyProfile({ providerId: 'glm' })).toBe(true);
    expect(hasProviderFamilyProfile({ providerId: 'qwen' })).toBe(false);
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




  test('deepseek profile resolveUserAgent ignores client/config passthrough and stays deepseek aligned', async () => {
    const deepseekProfile = getProviderFamilyProfile({ providerId: 'deepseek' });
    expect(deepseekProfile).toBeTruthy();

    const resolved = await deepseekProfile?.resolveUserAgent?.({
      uaFromConfig: 'curl/8.7.1',
      uaFromService: 'DeepSeek/1.0.13 Android/35',
      inboundUserAgent: 'codex-tui/0.118.0',
      defaultUserAgent: 'RouteCodex/2.0'
    } as any);

    expect(resolved).toBe('DeepSeek/2.0.4 Android/35');
  });






});
