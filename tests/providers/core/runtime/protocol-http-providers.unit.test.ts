import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import { jest } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { HttpTransportProvider } from '../../../../src/providers/core/runtime/http-transport-provider.js';
import { ResponsesProvider } from '../../../../src/providers/core/runtime/responses-provider.js';
import { AnthropicProtocolClient } from '../../../../src/client/anthropic/anthropic-protocol-client.js';
import { DeepSeekHttpProvider } from '../../../../src/providers/core/runtime/deepseek-http-provider.js';
import { attachProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';

jest.mock('../../../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
  createResponsesSseToJsonConverter: async () => ({
    convertSseToJson: async () => ({ status: 'completed', output: [] })
  })
}), { virtual: true });

jest.mock('../../../../src/modules/llmswitch/bridge/state-integrations.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} })
}), { virtual: true });

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('Protocol HTTP providers (V2) - basic behavior', () => {
  test('RED: HttpTransportProvider health check treats HTTP 404 as healthy without startup failure', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-health-404',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'test-health-404',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new HttpTransportProvider(config, emptyDeps, 'openai-http-provider') as any;
    provider.isInitialized = true;
    provider.buildRequestHeaders = async () => ({});
    provider.httpClient = {
      get: async () => {
        const err = Object.assign(new Error('HTTP 404: Not Found'), { statusCode: 404, code: 'HTTP_404' });
        throw err;
      }
    };

    await expect(provider.checkHealth()).resolves.toBe(true);
  });

  test('HttpTransportProvider with openai moduleType', () => {
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
    const provider = new HttpTransportProvider(config, emptyDeps, 'openai-http-provider');
    expect(provider.providerType).toBe('responses');
    expect(provider.type).toBe('openai-http-provider');
  });

  test('ResponsesProvider forces providerType=responses', () => {
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
    const provider = new ResponsesProvider(config, emptyDeps);
    expect(provider.providerType).toBe('openai');
    expect(provider.type).toBe('responses-http-provider');
  });

  test('ResponsesProvider direct passthrough preserves inbound responses shape and continuation fields', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async (_url: string, body: any, headers: Record<string, string>) => {
        provider.__lastDirect = { body, headers };
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_prev_turn',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
      store: false,
      stream: true,
      prompt_cache_key: 'cache-key-1',
      metadata: { entryEndpoint: '/v1/responses' }
    } as any;
    inbound.metadata.__responsesDirectPassthrough = true;
    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    const captured = provider.__lastDirect.body;
    expect(captured.model).toBe('gpt-5.4');
    expect(captured.previous_response_id).toBe('resp_prev_turn');
    expect(captured.input).toEqual(inbound.input);
    expect(captured.prompt_cache_key).toBe('cache-key-1');
    expect(captured.tools).toEqual(inbound.tools);
    expect(captured.tool_choice).toBe('auto');
    expect(captured.metadata).toBeUndefined();
  });

  test('ResponsesProvider honors explicit stream=false even when provider streaming preference is always', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-stream-false',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        responses: { streaming: 'always' },
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      post: async (_url: string, body: any) => {
        provider.__captured = { mode: 'json', body };
        return {
          data: {
            id: 'resp_1',
            object: 'response',
            status: 'completed',
            model: body.model,
            output: []
          }
        };
      },
      postStream: async () => {
        throw new Error('MUST_NOT_USE_SSE_WHEN_STREAM_FALSE');
      }
    };

    const outbound = await provider.sendRequestInternal({
      model: 'gpt-5.3-codex',
      stream: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
    });

    expect(provider.__captured?.mode).toBe('json');
    expect(provider.__captured?.body?.stream).toBeUndefined();
    expect((outbound as any)?.data?.status).toBe('completed');
  });

  test('HttpTransportProvider/anthropic derives SSE intent from context metadata and request stream flags', () => {
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
    const provider = new HttpTransportProvider(config, emptyDeps, 'anthropic-http-provider', new AnthropicProtocolClient()) as any;
    provider.lastRuntimeMetadata = { providerFamily: 'anthropic' };

    expect(provider.providerType).toBe('openai');
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

  test('HttpTransportProvider/openai (qwen) uses native web_search endpoint/body and honors official resource_url override', () => {
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
    const provider = new HttpTransportProvider(config, emptyDeps, 'openai-http-provider') as any;

    provider.authProvider = {
      getTokenPayload: () => ({ resource_url: 'dashscope.aliyuncs.com/compatible-mode' })
    };

    const endpoint = provider.resolveRequestEndpoint(
      {},
      '/chat/completions'
    );
    expect(endpoint).toBe('/chat/completions');

    const body = provider.buildHttpRequestBody({
      data: { model: 'coder-model', uq: 'routecodex', page: 1, rows: 5 }
    });
    expect(body).toEqual({ model: 'coder-model', uq: 'routecodex', page: 1, rows: 5 });

    provider.lastRuntimeMetadata = {
      qwenWebSearch: true,
      metadata: { qwenWebSearch: true, entryEndpoint: '/api/v1/indices/plugin/web_search' }
    };
    expect(provider.resolveRequestEndpoint({}, '/chat/completions')).toBe('/api/v1/indices/plugin/web_search');
    expect(provider.buildHttpRequestBody({ data: { model: 'coder-model', uq: 'routecodex', page: 1, rows: 5 } })).toEqual({
      uq: 'routecodex',
      page: 1,
      rows: 5
    });
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
    const aliasProvider = new HttpTransportProvider(aliasConfig, emptyDeps, 'openai-http-provider') as any;
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
