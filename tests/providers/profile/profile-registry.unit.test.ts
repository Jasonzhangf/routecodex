import { createHmac } from 'node:crypto';
import { describe, expect, test } from '@jest/globals';
import { getProviderFamilyProfile, hasProviderFamilyProfile } from '../../../src/providers/profile/profile-registry.js';

describe('provider family profile registry', () => {
  test('resolves iflow profile from provider key prefix', () => {
    const profile = getProviderFamilyProfile({
      providerKey: 'iflow.3-138.kimi-k2.5'
    });

    expect(profile).toBeTruthy();
    expect(profile?.providerFamily).toBe('iflow');
    expect(hasProviderFamilyProfile({ providerKey: 'iflow.3-138.kimi-k2.5' })).toBe(true);
  });

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

  test('iflow profile resolves endpoint/body for web search requests', () => {
    const profile = getProviderFamilyProfile({ providerId: 'iflow' });
    expect(profile).toBeTruthy();

    const endpoint = profile?.resolveEndpoint?.({
      request: {
        metadata: {
          iflowWebSearch: true,
          entryEndpoint: '/chat/retrieve'
        }
      } as any,
      defaultEndpoint: '/chat/completions'
    });
    expect(endpoint).toBe('/chat/retrieve');

    const entryEndpointFallback = profile?.resolveEndpoint?.({
      request: {
        metadata: {
          iflowWebSearch: true,
          entryEndpoint: '/v1/messages'
        }
      } as any,
      defaultEndpoint: '/chat/completions'
    });
    expect(entryEndpointFallback).toBe('/chat/completions');

    const body = profile?.buildRequestBody?.({
      request: {
        metadata: { iflowWebSearch: true },
        data: { query: 'routecodex' }
      } as any,
      defaultBody: { model: 'kimi-k2.5', messages: [] } as any
    });
    expect(body).toEqual({ query: 'routecodex' });

    const bodyFromDefault = profile?.buildRequestBody?.({
      request: {
        metadata: { iflowWebSearch: true, entryEndpoint: '/v1/messages' },
        data: { query: 'legacy-shape' }
      } as any,
      defaultBody: { model: 'minimax-m2.5', messages: [{ role: 'user', content: 'hi' }] } as any
    });
    expect(bodyFromDefault).toEqual({ model: 'minimax-m2.5', messages: [{ role: 'user', content: 'hi' }] });
  });

  test('iflow profile user-agent policy keeps config/service priority', () => {
    const profile = getProviderFamilyProfile({ providerId: 'iflow' });
    expect(profile).toBeTruthy();

    const fromService = profile?.resolveUserAgent?.({
      uaFromConfig: undefined,
      uaFromService: 'iFlow-Cli',
      inboundUserAgent: 'curl/8.7.1',
      defaultUserAgent: 'routecodex/default'
    });
    expect(fromService).toBe('iFlow-Cli');

    const fromFallback = profile?.resolveUserAgent?.({
      uaFromConfig: undefined,
      uaFromService: undefined,
      inboundUserAgent: undefined,
      defaultUserAgent: 'routecodex/default'
    });
    expect(fromFallback).toBe('routecodex/default');
  });

  test('iflow profile applies CLI session/signature headers', () => {
    const profile = getProviderFamilyProfile({ providerId: 'iflow' });
    expect(profile).toBeTruthy();

    const headers = profile?.applyRequestHeaders?.({
      headers: {
        Authorization: 'Bearer sk-test-iflow-signature-1234567890',
        'User-Agent': 'iFlow-Cli',
        session_id: 'sess-iflow-001',
        conversation_id: 'conv-iflow-001'
      }
    });

    expect(headers).toBeTruthy();
    expect(headers?.['session-id']).toBe('sess-iflow-001');
    expect(headers?.['conversation-id']).toBe('conv-iflow-001');
    expect(typeof headers?.['x-iflow-timestamp']).toBe('string');
    expect(typeof headers?.['x-iflow-signature']).toBe('string');

    const expected = createHmac('sha256', 'sk-test-iflow-signature-1234567890')
      .update(`iFlow-Cli:sess-iflow-001:${headers?.['x-iflow-timestamp']}`, 'utf8')
      .digest('hex');

    expect(headers?.['x-iflow-signature']).toBe(expected);
  });

  test('iflow profile does not auto-inject originator/session from request id', () => {
    const profile = getProviderFamilyProfile({ providerId: 'iflow' });
    expect(profile).toBeTruthy();

    const headers = profile?.applyRequestHeaders?.({
      headers: {
        Authorization: 'Bearer sk-test-iflow-signature-1234567890',
        'User-Agent': 'iFlow-Cli'
      },
      runtimeMetadata: {
        requestId: 'req-iflow-001',
        metadata: {}
      } as any
    });

    expect(headers?.originator).toBeUndefined();
    expect(headers?.['session_id']).toBeUndefined();
    expect(headers?.['session-id']).toBeUndefined();
  });

  test('iflow profile maps HTTP200 business envelope to provider error', () => {
    const profile = getProviderFamilyProfile({ providerId: 'iflow' });
    expect(profile).toBeTruthy();

    const businessError = profile?.resolveBusinessResponseError?.({
      response: {
        data: {
          error_code: 'iflow_business_error',
          msg: 'Model not support'
        }
      }
    });

    expect(businessError).toBeTruthy();
    expect(String(businessError?.message || '')).toContain('Model not support');

    const tokenExpired = profile?.resolveBusinessResponseError?.({
      response: {
        data: {
          status: 439,
          msg: 'token has expired'
        }
      }
    });
    expect(String(tokenExpired?.message || '')).toContain('token has expired');
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

  test('qwen/iflow profiles decide OAuth token-file mode', () => {
    const qwenProfile = getProviderFamilyProfile({ providerId: 'qwen' });
    const iflowProfile = getProviderFamilyProfile({ providerId: 'iflow' });

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

    expect(
      iflowProfile?.resolveOAuthTokenFileMode?.({
        oauthProviderId: 'iflow',
        auth: {},
        moduleType: 'iflow-http-provider'
      })
    ).toBe(true);
  });
});
