import { Readable } from 'node:stream';

import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
  reportProviderErrorToRouterPolicy: async () => {},
  reportProviderSuccessToRouterPolicy: async () => {},
  writeSnapshotViaHooks: async () => {},
  convertResponsesRequestToChatNative: (payload: Record<string, unknown>) => ({
    messages: payload.messages ?? [],
    tools: payload.tools
  }),
  sanitizeProviderOutboundPayload: async (input: { payload: Record<string, unknown> }) => {
    const next = structuredClone(input.payload);
    if (Array.isArray(next.input)) {
      next.input = next.input.map((item: any) => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== 'reasoning') {
          return item;
        }
        const sanitized = { ...item };
        delete sanitized.content;
        delete sanitized.encrypted_content;
        return sanitized;
      });
    }
    return next;
  },
  createResponsesSseToJsonConverter: async () => ({
    convertSseToJson: async () => ({ status: 'completed', output: [] })
  })
}), { virtual: true });

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/state-integrations.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} })
}), { virtual: true });

import type { OpenAIStandardConfig } from '../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { attachProviderRuntimeMetadata } from '../../../src/providers/core/runtime/provider-runtime-metadata.js';

const { ResponsesProvider } = await import('../../../src/providers/core/runtime/responses-provider.js');

const emptyDeps: ModuleDependencies = {
  logger: {
    logModule: () => {},
    logProviderRequest: () => {}
  } as any
} as ModuleDependencies;

describe('ResponsesProvider direct passthrough', () => {
  test('sends the original direct request object without provider-side metadata validation', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-metadata-boundary',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'cc',
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
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
      metadata: { __responsesDirectPassthrough: true }
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: { __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody).toBe(inbound);
  });

  test('does not sanitize reasoning content on direct provider path', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-reasoning-filter',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'cc',
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
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'must not reach provider runtime' }],
          encrypted_content: null,
          summary: [{ type: 'summary_text', text: 'summary stays' }]
        }
      ],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody).toBe(inbound);
    expect(capturedBody.input[1].type).toBe('reasoning');
    expect(capturedBody.input[1].content).toEqual([{ type: 'reasoning_text', text: 'must not reach provider runtime' }]);
    expect(capturedBody.input[1].encrypted_content).toBeNull();
  });

  test('preserves inbound responses payload without rebuilding input/history/model', async () => {
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

    let capturedBody: any;
    let capturedHeaders: Record<string, string> | undefined;
    provider.httpClient = {
      postStream: async (_url: string, body: any, headers: Record<string, string>) => {
        capturedBody = body;
        capturedHeaders = headers;
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
      instructions: 'keep-original-instructions'
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });
    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedHeaders?.Accept).toBe('text/event-stream');
    expect(capturedBody).toBe(inbound);
    expect(capturedBody.model).toBe('gpt-5.4');
    expect(capturedBody.previous_response_id).toBe('resp_prev_turn');
    expect(capturedBody.input).toEqual(inbound.input);
    expect(capturedBody.prompt_cache_key).toBe('cache-key-1');
    expect(capturedBody.tools).toEqual(inbound.tools);
    expect(capturedBody.tool_choice).toBe('auto');
    expect(capturedBody.instructions).toBe('keep-original-instructions');
    expect(capturedBody.metadata).toBeUndefined();
  });

  test('passes Responses no-content timeout into provider SSE transport idle timeout', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-provider-idle-timeout',
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

    let capturedStreamConfig: { idleTimeoutMs?: number } | undefined;
    provider.httpClient = {
      postStream: async (_url: string, _body: any, _headers: Record<string, string>, streamConfig?: { idleTimeoutMs?: number }) => {
        capturedStreamConfig = streamConfig;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', providerStreamNoContentTimeoutMs: 75 }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedStreamConfig).toEqual({ idleTimeoutMs: 75 });
  });

  test('maps direct HTTP 200 SSE response.failed concurrency to retryable provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-rate-limit',
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
      postStream: async () => Readable.from([
        'event: response.failed\n',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'rate_limit_error',
              message: 'Concurrency limit exceeded for user, please retry later'
            }
          }
        })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'PROVIDER_TRAFFIC_SATURATED',
      upstreamCode: 'rate_limit_error',
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

  test('maps CRLF direct HTTP 200 SSE response.failed concurrency to retryable provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-rate-limit-crlf',
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
      postStream: async () => Readable.from([
        'event: response.failed\r\n',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'rate_limit_error',
              message: 'Concurrency limit exceeded for user, please retry later'
            }
          }
        })}\r\n\r\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'PROVIDER_TRAFFIC_SATURATED',
      upstreamCode: 'rate_limit_error',
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

  test('maps direct HTTP 200 SSE codex.rate_limits limit_reached to retryable provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-codex-rate-limits',
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
      postStream: async () => Readable.from([
        'event: codex.rate_limits\n',
        `data: ${JSON.stringify({ type: 'codex.rate_limits', limit_reached: true })}\n\n`,
        'event: response.created\n',
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_after_limit', status: 'in_progress' } })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'PROVIDER_TRAFFIC_SATURATED',
      upstreamCode: 'codex.rate_limits',
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

  test('replays direct HTTP 200 SSE normal frames after filtering advisory codex rate-limit frames', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-normal',
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
      postStream: async () => Readable.from([
        'event: codex.rate_limits\n',
        `data: ${JSON.stringify({ type: 'codex.rate_limits', limit_reached: false })}\n\n`,
        'event: response.created\n',
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_ok', status: 'in_progress' } })}\n\n`,
        'event: response.completed\n',
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_ok', status: 'completed' } })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    const result = await provider.sendRequestInternal(inbound);
    const chunks: Buffer[] = [];
    for await (const chunk of result.__sse_responses) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).not.toContain('event: codex.rate_limits');
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('resp_ok');
  });
});
