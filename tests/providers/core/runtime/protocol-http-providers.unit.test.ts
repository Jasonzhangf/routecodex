import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';
import { jest } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { __flushProviderSnapshotQueueForTests, __resetProviderSnapshotErrorBufferForTests } from '../../../../src/providers/core/utils/snapshot-writer.js';
import { allowSnapshotLocalDiskWrite, __resetSnapshotLocalDiskGateForTests } from '../../../../src/utils/snapshot-local-disk-gate.js';
import { runtimeFlags, setRuntimeFlag } from '../../../../src/runtime/runtime-flags.js';
import { sanitizeProviderOutboundPayloadWithNative } from '../../../sharedmodule/helpers/native-hub-bridge-policy-direct-native.js';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  sanitizeProviderOutboundPayload: async (input: {
    protocol?: string;
    compatibilityProfile?: string;
    payload: Record<string, unknown>;
  }) => sanitizeProviderOutboundPayloadWithNative(input),
  normalizeResponsesDirectCurrentRequestPayload: (input: { payload?: Record<string, unknown> }) => input.payload ?? {},
  convertResponsesRequestToChatNative: (payload: Record<string, unknown>) => ({
    request: {
      model: payload.model,
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '/Users/fanzhang/Documents/github/routecodex'
        }
      ],
      tools: payload.tools
    }
  }),
}), { virtual: true });

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/provider-outbound-sanitize-host.js', () => ({
  sanitizeProviderOutboundPayload: async (input: {
    protocol?: string;
    compatibilityProfile?: string;
    payload: Record<string, unknown>;
  }) => sanitizeProviderOutboundPayloadWithNative(input),
}), { virtual: true });

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  reportProviderErrorToRouterPolicy: async () => {},
  reportProviderSuccessToRouterPolicy: async () => {},
  buildResponsesJsonFromSseStreamWithNative: async () => ({
    status: 'completed',
    output: []
  })
}), { virtual: true });

const { HttpTransportProvider } = await import('../../../../src/providers/core/runtime/http-transport-provider.js');
const { HttpRequestExecutor } = await import('../../../../src/providers/core/runtime/http-request-executor.js');
const { ResponsesProvider } = await import('../../../../src/providers/core/runtime/responses-provider.js');
const { AnthropicProtocolClient } = await import('../../../../src/client/anthropic/anthropic-protocol-client.js');
const { attachProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;

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

  test('HTTP TRANSPORT RED: openai chat materializes responses tool continuation with native codec', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-openai-chat-responses-tool-continuation',
      type: 'openai-http-provider',
      config: {
        providerType: 'openai',
        providerId: 'test-openai-chat-responses-tool-continuation',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/chat/completions' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new HttpTransportProvider(config, emptyDeps, 'openai-http-provider') as any;
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.postprocessResponse = async (response: unknown) => response;

    let sentBody: Record<string, unknown> | undefined;
    const fakeHttpClient = {
      post: async (_url: string, body: Record<string, unknown>) => {
        sentBody = body;
        return { status: 200, data: { id: 'chatcmpl_test', choices: [] } };
      }
    };
    await provider.initialize();
    provider.httpClient = fakeHttpClient;
    provider.requestExecutor = new HttpRequestExecutor(
      provider.httpClient,
      provider.createRequestExecutorDeps()
    );

    const request: Record<string, unknown> = {
      model: 'gpt-5.4-mini',
      previous_response_id: 'resp_prev',
      input: [
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '/Users/fanzhang/Documents/github/routecodex'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
        }
      ],
      stream: false
    };
    attachProviderRuntimeMetadata(request, {
      requestId: 'req_openai_chat_responses_tool_continuation',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      providerId: 'asxs',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
      metadata: { entryEndpoint: '/v1/responses' }
    });

    const processed = await provider.preprocessRequest(request);
    await provider.sendRequestInternal(processed);

    expect(sentBody?.input).toBeUndefined();
    expect(sentBody?.previous_response_id).toBeUndefined();
    expect(Array.isArray(sentBody?.messages)).toBe(true);
    const messages = sentBody?.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))).toBe(true);
    expect(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1')).toBe(true);
  });

  test('HTTP TRANSPORT RED: openai responses provider-request snapshot preserves tool continuation wire shape', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-openai-responses-provider-request-snapshot',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'asxs',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const previousSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
    const previousCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
    const previousSnapshotFlag = runtimeFlags.snapshotsEnabled;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-provider-snapshot-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
    __resetProviderSnapshotErrorBufferForTests();
    __resetSnapshotLocalDiskGateForTests();

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.createProviderContext = () => ({
      requestId: 'req_openai_responses_provider_request_snapshot',
      providerType: 'responses',
      startTime: Date.now(),
      profile: {},
      providerId: 'asxs',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
      providerProtocol: 'openai-responses',
      metadata: { entryEndpoint: '/v1/responses', entryPort: 5555, matchedPort: 5555 }
    });
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async (_url: string, body: any) => {
        provider.__lastDirect = { body };
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.4-mini',
      previous_response_id: 'resp_prev',
      input: [
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
      ],
      tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
      stream: true
    } as any;

    allowSnapshotLocalDiskWrite('req_openai_responses_provider_request_snapshot');
    attachProviderRuntimeMetadata(inbound, {
      requestId: 'req_openai_responses_provider_request_snapshot',
      providerType: 'responses',
      providerProtocol: 'openai-responses',
      providerId: 'asxs',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
      metadata: { entryEndpoint: '/v1/responses', entryPort: 5555, matchedPort: 5555 }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    await __flushProviderSnapshotQueueForTests();

    const snapshotPath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      'req_openai_responses_provider_request_snapshot',
      'provider-request.json'
    );
    const snapshotRaw = await fs.readFile(snapshotPath, 'utf8');
    const snapshot = JSON.parse(snapshotRaw) as { body?: Record<string, unknown> };
    const providerBody = snapshot.body ?? {};

    expect(providerBody).toMatchObject({
      model: 'gpt-5.4-mini',
      previous_response_id: 'resp_prev',
      stream: true
    });
    expect(providerBody.input).toEqual([
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
    ]);
    expect(providerBody.messages).toBeUndefined();

    __resetSnapshotLocalDiskGateForTests();
    if (previousSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = previousSnapshotDir;
    }
    if (previousCompatSnapshotDir === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = previousCompatSnapshotDir;
    }
    setRuntimeFlag('snapshotsEnabled', previousSnapshotFlag);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('HTTP TRANSPORT RED: openai responses provider-request snapshot normalizes image_url parts to input_image wire shape', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-openai-responses-provider-request-image-normalization',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'asxs',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const previousSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
    const previousCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
    const previousSnapshotFlag = runtimeFlags.snapshotsEnabled;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-provider-snapshot-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
    __resetProviderSnapshotErrorBufferForTests();
    __resetSnapshotLocalDiskGateForTests();

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.createProviderContext = () => ({
      requestId: 'req_openai_responses_provider_request_image_normalization',
      providerType: 'responses',
      startTime: Date.now(),
      profile: {},
      providerId: 'asxs',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
      providerProtocol: 'openai-responses',
      metadata: { entryEndpoint: '/v1/responses', entryPort: 5555, matchedPort: 5555 }
    });
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async (_url: string, body: any) => {
        provider.__lastDirect = { body };
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.4-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1]>' },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,AAA',
                detail: 'high'
              }
            },
            { type: 'input_text', text: '[Image #1]' }
          ]
        }
      ],
      stream: true
    } as any;

    allowSnapshotLocalDiskWrite('req_openai_responses_provider_request_image_normalization');
    attachProviderRuntimeMetadata(inbound, {
      requestId: 'req_openai_responses_provider_request_image_normalization',
      providerType: 'responses',
      providerProtocol: 'openai-responses',
      providerId: 'asxs',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
      metadata: { entryEndpoint: '/v1/responses', entryPort: 5555, matchedPort: 5555 }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    await __flushProviderSnapshotQueueForTests();

    const snapshotPath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      'req_openai_responses_provider_request_image_normalization',
      'provider-request.json'
    );
    const snapshotRaw = await fs.readFile(snapshotPath, 'utf8');
    const snapshot = JSON.parse(snapshotRaw) as { body?: Record<string, unknown> };
    const providerBody = snapshot.body ?? {};
    const input = providerBody.input as Array<Record<string, unknown>>;
    const content = input[0]?.content as Array<Record<string, unknown>>;

    expect(content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,AAA'
    });
    expect(JSON.stringify(providerBody)).not.toContain('"type":"image_url"');

    __resetSnapshotLocalDiskGateForTests();
    if (previousSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = previousSnapshotDir;
    }
    if (previousCompatSnapshotDir === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = previousCompatSnapshotDir;
    }
    setRuntimeFlag('snapshotsEnabled', previousSnapshotFlag);
    await fs.rm(tempDir, { recursive: true, force: true });
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
    let capturedBody: any;
    provider.httpClient = {
      post: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      },
      postStream: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    await expect(provider.processIncomingDirect({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'exec_command' } }],
      stream: false
    })).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('ResponsesProvider direct passthrough sends chat-style response tools to transport', async () => {
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
    let capturedBody: any;
    provider.httpClient = {
      post: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      },
      postStream: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    await expect(provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      tools: [{ type: 'function', function: { name: 'exec_command' } }],
      stream: false
    })).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody.tools).toEqual([{ type: 'function', function: { name: 'exec_command' } }]);
  });

  test('ResponsesProvider direct passthrough prefers selected provider modelId over inbound routeParams.model', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-selected-model-id',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'tokenrelay',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;
    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    let capturedBody: any;
    provider.httpClient = {
      postStream: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      modelId: 'deepseek-v4-pro',
      target: {
        providerKey: 'tokenrelay.key1.deepseek-v4-pro',
        runtimeKey: 'tokenrelay.key1.deepseek-v4-pro',
        modelId: 'deepseek-v4-pro'
      },
      metadata: {
        routeParams: {
          model: 'gpt-5.4',
        }
      }
    });

    await expect(provider.processIncomingDirect(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody.model).toBe('deepseek-v4-pro');
  });

  test('ResponsesProvider sends historical tool input content to transport', async () => {
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
    let capturedBody: any;
    provider.httpClient = {
      post: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      },
      postStream: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      }
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
    })).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody.input[1].content).toEqual([{ type: 'output_text', text: 'historical leak' }]);
  });

  test('ResponsesProvider uses upstream SSE when provider streaming preference is always even if client stream=false', async () => {
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
    provider.snapshotPhase = async (phase: string, _context: unknown, _data: unknown, headers: Record<string, string>) => {
      if (phase === 'provider-request') {
        provider.__snapshotHeaders = headers;
      }
    };
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      post: async () => {
        throw new Error('MUST_NOT_USE_JSON_WHEN_STREAMING_ALWAYS');
      },
      postStream: async (_url: string, body: any, headers: Record<string, string>) => {
        provider.__captured = { mode: 'sse', body, headers };
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    await expect(provider.sendRequestInternal({
      model: 'gpt-5.3-codex',
      stream: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
    })).rejects.toThrow('STOP_AFTER_CAPTURE');

    expect(provider.__captured?.mode).toBe('sse');
    expect(provider.__captured?.headers?.Accept).toBe('text/event-stream');
    expect(provider.__snapshotHeaders?.Accept).toBe('text/event-stream');
    expect(provider.__captured?.body?.stream).toBe(true);
  });

  test('HttpTransportProvider accepts JSON response when upstream ignores SSE request', async () => {
    const executor = new HttpRequestExecutor({
      post: async () => {
        throw new Error('MUST_NOT_REISSUE_JSON_REQUEST');
      },
      postStream: async () => {
        throw new Error('MUST_NOT_USE_STREAM_ONLY_PATH');
      },
      postStreamOrResponse: async () => ({
        kind: 'response',
        responseKind: 'json',
        response: {
          data: {
            id: 'chatcmpl-json',
            object: 'chat.completion',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'json-ok' }, finish_reason: 'stop' }
            ]
          },
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          url: 'https://example.invalid/v1/chat/completions'
        }
      })
    } as any, {
      wantsUpstreamSse: () => true,
      getEffectiveEndpoint: () => '/chat/completions',
      resolveRequestEndpoint: (_request: unknown, defaultEndpoint: string) => defaultEndpoint,
      buildRequestHeaders: async () => ({ Authorization: 'Bearer test-key-1234567890' }),
      finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
      applyStreamModeHeaders: (headers: Record<string, string>) => ({ ...headers, Accept: 'text/event-stream' }),
      getEffectiveBaseUrl: () => 'https://example.invalid/v1',
      buildHttpRequestBody: (request: Record<string, unknown>) => request,
      prepareSseRequestBody: (body: Record<string, unknown>) => { body.stream = true; },
      getEntryEndpointFromPayload: () => '/v1/chat/completions',
      getClientRequestIdFromContext: () => undefined,
      wrapUpstreamSseResponse: async () => {
        throw new Error('MUST_NOT_PARSE_JSON_AS_SSE');
      },
      normalizeHttpError: async (error: unknown) => error as any
    } as any);

    const result = await executor.execute({
      model: 'gpt-5.4',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    }, { requestId: 'req-json-over-sse', providerKey: 'tokenrelay.key1.deepseek-v4-pro' } as any);

    expect((result as any).data.choices[0].message.content).toBe('json-ok');
  });

  test('ResponsesProvider streaming=always accepts JSON response when upstream ignores SSE request', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-streaming-always-json-response',
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
      post: async () => {
        throw new Error('MUST_NOT_REISSUE_JSON_REQUEST');
      },
      postStream: async () => {
        throw new Error('MUST_NOT_USE_STREAM_ONLY_PATH');
      },
      postStreamOrResponse: async () => ({
        kind: 'response',
        responseKind: 'json',
        response: {
          data: {
            id: 'resp_json',
            object: 'response',
            status: 'completed',
            output: []
          },
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          url: 'https://example.invalid/v1/responses'
        }
      })
    };

    const result = await provider.sendRequestInternal({
      model: 'gpt-5.4',
      stream: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
    });

    expect((result as any).data.status).toBe('completed');
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

});
