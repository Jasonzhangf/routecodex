import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { OpenAIHttpProvider } from '../../../../src/providers/core/runtime/openai-http-provider.js';
import { ResponsesHttpProvider } from '../../../../src/providers/core/runtime/responses-http-provider.js';
import { AnthropicHttpProvider } from '../../../../src/providers/core/runtime/anthropic-http-provider.js';
import { iFlowHttpProvider } from '../../../../src/providers/core/runtime/iflow-http-provider.js';
import { DeepSeekHttpProvider } from '../../../../src/providers/core/runtime/deepseek-http-provider.js';
import { attachProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('Protocol HTTP providers (V2) - basic behavior', () => {
  test('OpenAIHttpProvider forces providerType=openai', () => {
    const config: OpenAIStandardConfig = {
      id: 'test-openai',
      type: 'openai-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
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
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
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
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
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
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' }
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

    const messagesEntryEndpoint = provider.resolveRequestEndpoint(
      { metadata: { iflowWebSearch: true, entryEndpoint: '/v1/messages' } },
      '/chat/completions'
    );
    expect(messagesEntryEndpoint).toBe('/chat/completions');

    const body = provider.buildHttpRequestBody({
      metadata: { iflowWebSearch: true },
      data: { model: 'kimi-k2.5', q: 'x' }
    });
    expect(body).toEqual({ model: 'kimi-k2.5', q: 'x' });

    const bodyFallback = provider.buildHttpRequestBody({
      metadata: { iflowWebSearch: true, entryEndpoint: '/v1/messages' },
      model: 'minimax-m2.5',
      messages: [{ role: 'user', content: 'hello' }]
    });
    expect(bodyFallback).toEqual({
      model: 'minimax-m2.5',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'hello' }]
    });
  });

  test('OpenAIHttpProvider (qwen) uses native web_search endpoint/body and resource_url base override', () => {
    const config: OpenAIStandardConfig = {
      id: 'test-qwen',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwen',
        auth: { type: 'qwen-oauth', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://portal.qwen.ai/v1', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new OpenAIHttpProvider(config, emptyDeps) as any;

    provider.authProvider = {
      getTokenPayload: () => ({ resource_url: 'portal.qwen.ai' })
    };

    const endpoint = provider.resolveRequestEndpoint(
      { metadata: { qwenWebSearch: true, entryEndpoint: '/api/v1/indices/plugin/web_search' } },
      '/chat/completions'
    );
    expect(endpoint).toBe('/api/v1/indices/plugin/web_search');

    const body = provider.buildHttpRequestBody({
      metadata: { qwenWebSearch: true },
      data: { model: 'qwen3-coder-plus', uq: 'routecodex', page: 1, rows: 5 }
    });
    expect(body).toEqual({ uq: 'routecodex', page: 1, rows: 5 });

    provider.lastRuntimeMetadata = { metadata: { qwenWebSearch: true } };
    expect(provider.resolveAuthResourceBaseUrlOverride()).toBe('https://portal.qwen.ai');

    provider.lastRuntimeMetadata = { metadata: {} };
    expect(provider.resolveAuthResourceBaseUrlOverride()).toBe('https://portal.qwen.ai/v1');
  });

  test('DeepSeekHttpProvider keeps openai providerType and deepseek module type', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-protocol-'));
    tempDirs.push(tempDir);
    const tokenFile = path.join(tempDir, 'deepseek-account-1.json');
    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'deepseek-token' }, null, 2) + '\n', 'utf8');

    const config: OpenAIStandardConfig = {
      id: 'test-deepseek',
      type: 'deepseek-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'deepseek',
        auth: {
          type: 'apikey',
          rawType: 'deepseek-account',
          apiKey: '',
          tokenFile
        }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new DeepSeekHttpProvider(config, emptyDeps);
    await provider.initialize();

    expect(provider.providerType).toBe('openai');
    expect(provider.type).toBe('deepseek-http-provider');
  });

  test('iFlowHttpProvider treats HTTP 200 business error envelope as provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-iflow-business-envelope',
      type: 'iflow-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'iflow',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;

    class IflowBusinessEnvelopeProvider extends iFlowHttpProvider {
      protected override createHttpClient(): void {
        this.httpClient = {
          post: async () => ({
            data: { error_code: 'AllModelsFailed', msg: '请求供应商服务器失败' },
            status: 200,
            statusText: 'OK',
            headers: {},
            url: 'https://example.invalid/chat/completions'
          }),
          postStream: async () => {
            throw new Error('postStream not expected');
          },
          get: async () => ({
            data: {},
            status: 200,
            statusText: 'OK',
            headers: {},
            url: 'https://example.invalid/health'
          })
        } as any;
      }
    }

    const provider = new IflowBusinessEnvelopeProvider(config, emptyDeps) as any;
    await provider.initialize();

    const request = {
      metadata: { stream: false },
      data: { model: 'kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] }
    };

    attachProviderRuntimeMetadata(request as Record<string, unknown>, {
      requestId: 'req-iflow-business-envelope',
      providerId: 'iflow',
      providerKey: 'iflow.key1.kimi-k2.5',
      providerType: 'openai',
      providerFamily: 'iflow',
      providerProtocol: 'openai-chat',
      routeName: 'test',
      metadata: { entryEndpoint: '/v1/responses' },
      target: {
        providerKey: 'iflow.key1.kimi-k2.5',
        providerType: 'openai',
        runtimeKey: 'iflow.key1',
        modelId: 'kimi-k2.5'
      }
    });

    let caught: any;
    try {
      await provider.processIncoming(request as any);
    } catch (error) {
      caught = error as any;
    }

    expect(caught).toBeTruthy();
    expect(String(caught.message || '')).toContain('iFlow business error');
    expect(String(caught.message || '')).toContain('AllModelsFailed');
  });
});
