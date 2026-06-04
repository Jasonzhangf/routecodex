import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import { jest } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { HttpTransportProvider } from '../../../../src/providers/core/runtime/http-transport-provider.js';
import { HttpRequestExecutor } from '../../../../src/providers/core/runtime/http-request-executor.js';
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

  test('HTTP TRANSPORT RED: openai chat preserves stream protocol field through final provider body', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-openai-chat-stream-preserve',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'test-openai-chat-stream-preserve',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new HttpTransportProvider(config, emptyDeps, 'openai-http-provider') as any;
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.postprocessResponse = async (response: unknown) => response;

    let sentBody: Record<string, unknown> | undefined;
    let sentHeaders: Record<string, string> | undefined;
    const fakeHttpClient = {
      post: async (_url: string, body: Record<string, unknown>, headers: Record<string, string>) => {
        sentBody = body;
        sentHeaders = headers;
        return { status: 200, data: { id: 'chatcmpl_test', choices: [] } };
      },
      postStream: async (_url: string, body: Record<string, unknown>, headers: Record<string, string>) => {
        sentBody = body;
        sentHeaders = headers;
        return { pipe: () => undefined } as unknown as NodeJS.ReadableStream;
      }
    };
    await provider.initialize();
    provider.httpClient = fakeHttpClient;
    provider.requestExecutor = new HttpRequestExecutor(
      provider.httpClient,
      provider.createRequestExecutorDeps()
    );

    const request: Record<string, unknown> = {
      model: 'deepseek-v4-flash-free',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'ping' }]
    };
    attachProviderRuntimeMetadata(request, {
      requestId: 'req_openai_chat_stream_preserve',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      providerId: 'opencode-zen-free',
      providerKey: 'opencode-zen-free.deepseek-v4-flash-free',
      metadata: { stream: true }
    });

    const processed = await provider.preprocessRequest(request);
    await provider.sendRequestInternal(processed);

    expect(sentBody?.model).toBe('deepseek-v4-flash-free');
    expect(sentBody?.stream).toBe(true);
    expect(sentBody?.stream_options).toEqual({ include_usage: true });
    expect(sentHeaders?.Accept).toBe('text/event-stream');
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
      prompt_cache_key: 'cache-key-1'
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });
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

  test('ResponsesProvider direct passthrough rejects chat-shaped payload before transport', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-chat-shape-reject',
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
      post: async () => { throw new Error('MUST_NOT_CALL_TRANSPORT'); },
      postStream: async () => { throw new Error('MUST_NOT_CALL_TRANSPORT'); }
    };

    await expect(provider.processIncomingDirect({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'exec_command' } }],
      stream: false
    })).rejects.toThrow(/chat-style "messages"/);
  });

  test('ResponsesProvider direct passthrough rejects chat-style response tools before transport', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-chat-tools-reject',
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
      post: async () => { throw new Error('MUST_NOT_CALL_TRANSPORT'); },
      postStream: async () => { throw new Error('MUST_NOT_CALL_TRANSPORT'); }
    };

    await expect(provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      tools: [{ type: 'function', function: { name: 'exec_command' } }],
      stream: false
    })).rejects.toThrow(/chat-style function tool/);
  });

  test('ResponsesProvider rejects historical tool input content before transport', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-historical-tool-content-reject',
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
      post: async () => { throw new Error('MUST_NOT_CALL_TRANSPORT'); },
      postStream: async () => { throw new Error('MUST_NOT_CALL_TRANSPORT'); }
    };

    await expect(provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'ok',
          content: [{ type: 'output_text', text: 'historical leak' }]
        }
      ],
      stream: false
    })).rejects.toThrow(/function_call_output must not carry content/);
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
    expect(body).toEqual({ model: 'coder-model', uq: 'routecodex', page: 1, rows: 5, max_tokens: 8192 });

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
