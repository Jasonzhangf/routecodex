import { describe, expect, test } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { OpenAIHttpProvider } from '../../../../src/providers/core/runtime/openai-http-provider.js';
import { ResponsesHttpProvider } from '../../../../src/providers/core/runtime/responses-http-provider.js';
import { AnthropicHttpProvider } from '../../../../src/providers/core/runtime/anthropic-http-provider.js';
import { iFlowHttpProvider } from '../../../../src/providers/core/runtime/iflow-http-provider.js';

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;

describe('Protocol HTTP providers (V2) - basic behavior', () => {
  test('OpenAIHttpProvider forces providerType=openai', () => {
    const config: OpenAIStandardConfig = {
      id: 'test-openai',
      type: 'openai-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key' },
        overrides: { baseUrl: 'https://example.invalid', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new OpenAIHttpProvider(config, emptyDeps);
    expect(provider.providerType).toBe('openai');
    expect(provider.type).toBe('openai-http-provider');
  });

  test('ResponsesHttpProvider forces providerType=responses', () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses',
      type: 'responses-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key' },
        overrides: { baseUrl: 'https://example.invalid', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new ResponsesHttpProvider(config, emptyDeps);
    expect(provider.providerType).toBe('responses');
    expect(provider.type).toBe('responses-http-provider');
  });

  test('AnthropicHttpProvider derives SSE intent from context metadata and request stream flags', () => {
    const config: OpenAIStandardConfig = {
      id: 'test-anthropic',
      type: 'anthropic-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key' },
        overrides: { baseUrl: 'https://example.invalid', endpoint: '/v1/messages' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new AnthropicHttpProvider(config, emptyDeps) as any;

    expect(provider.providerType).toBe('anthropic');
    expect(provider.type).toBe('anthropic-http-provider');

    const wantsFromContext = provider.wantsUpstreamSse({ stream: false }, { metadata: { stream: true } });
    expect(wantsFromContext).toBe(true);

    const wantsFromRequest = provider.wantsUpstreamSse({ stream: true }, { metadata: {} });
    expect(wantsFromRequest).toBe(true);

    const defaultFalse = provider.wantsUpstreamSse({}, { metadata: {} });
    expect(defaultFalse).toBe(false);

    const body: Record<string, unknown> = {};
    provider.prepareSseRequestBody(body);
    expect(body.stream).toBe(true);
  });

  test('iFlowHttpProvider uses webSearch request envelope when metadata.iflowWebSearch=true', () => {
    const config: OpenAIStandardConfig = {
      id: 'test-iflow',
      type: 'iflow-http-provider',
      config: {
        providerType: 'openai',
        auth: { type: 'apikey', apiKey: 'test-key' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new iFlowHttpProvider(config, emptyDeps) as any;

    expect(provider.providerType).toBe('openai');
    expect(String(provider.config?.config?.providerId)).toBe('iflow');
    expect(provider.type).toBe('iflow-http-provider');

    const endpoint = provider.resolveRequestEndpoint(
      { metadata: { iflowWebSearch: true, entryEndpoint: '/chat/retrieve' } },
      '/chat/completions'
    );
    expect(endpoint).toBe('/chat/retrieve');

    const fallbackEndpoint = provider.resolveRequestEndpoint(
      { metadata: { iflowWebSearch: true, entryEndpoint: '' } },
      '/chat/completions'
    );
    expect(fallbackEndpoint).toBe('/chat/retrieve');

    const body = provider.buildHttpRequestBody({ metadata: { iflowWebSearch: true }, data: { q: 'x' } });
    expect(body).toEqual({ q: 'x' });
  });
});

