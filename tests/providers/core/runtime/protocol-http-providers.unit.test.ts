import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { OpenAIHttpProvider } from '../../../../src/providers/core/runtime/openai-http-provider.js';
import { ResponsesHttpProvider } from '../../../../src/providers/core/runtime/responses-http-provider.js';
import { AnthropicHttpProvider } from '../../../../src/providers/core/runtime/anthropic-http-provider.js';
import { DeepSeekHttpProvider } from '../../../../src/providers/core/runtime/deepseek-http-provider.js';

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

  test('OpenAIHttpProvider (qwen) uses native web_search endpoint/body and honors official resource_url override', () => {
    const config: OpenAIStandardConfig = {
      id: 'test-qwen',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwen',
        auth: { type: 'qwen-oauth', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new OpenAIHttpProvider(config, emptyDeps) as any;

    provider.authProvider = {
      getTokenPayload: () => ({ resource_url: 'dashscope.aliyuncs.com/compatible-mode' })
    };

    const endpoint = provider.resolveRequestEndpoint(
      { metadata: { qwenWebSearch: true, entryEndpoint: '/api/v1/indices/plugin/web_search' } },
      '/chat/completions'
    );
    expect(endpoint).toBe('/api/v1/indices/plugin/web_search');

    const body = provider.buildHttpRequestBody({
      metadata: { qwenWebSearch: true },
      data: { model: 'coder-model', uq: 'routecodex', page: 1, rows: 5 }
    });
    expect(body).toEqual({ uq: 'routecodex', page: 1, rows: 5 });

    provider.lastRuntimeMetadata = { metadata: { qwenWebSearch: true } };
    expect(provider.resolveAuthResourceBaseUrlOverride()).toBe('https://dashscope.aliyuncs.com/compatible-mode');

    provider.lastRuntimeMetadata = { metadata: {} };
    expect(provider.resolveAuthResourceBaseUrlOverride()).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');

    provider.authProvider = {
      getTokenPayload: () => ({ resource_url: 'portal.qwen.ai' })
    };
    provider.getRuntimeProfile = () => ({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    expect(provider.resolveAuthResourceBaseUrlOverride()).toBe('https://portal.qwen.ai/v1');
    expect(provider.getEffectiveBaseUrl()).toBe('https://portal.qwen.ai/v1');

    const aliasConfig: OpenAIStandardConfig = {
      id: 'test-qwen-alias',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwen-jasonqueque',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;
    const aliasProvider = new OpenAIHttpProvider(aliasConfig, emptyDeps) as any;
    aliasProvider.oauthProviderId = 'qwen';
    aliasProvider.authProvider = {
      getTokenPayload: () => ({ resource_url: 'portal.qwen.ai' })
    };
    aliasProvider.getRuntimeProfile = () => ({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    expect(aliasProvider.resolveAuthResourceBaseUrlOverride()).toBe('https://portal.qwen.ai/v1');
    expect(aliasProvider.getEffectiveBaseUrl()).toBe('https://portal.qwen.ai/v1');
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

});
