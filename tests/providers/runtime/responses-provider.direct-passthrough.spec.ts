import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

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
  sanitizeProviderOutboundPayload: async (input: { payload: Record<string, unknown> }) => input.payload,
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

  test('preserves reasoning content on direct provider path before sending upstream', async () => {
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
    expect(capturedBody.input[1].content).toEqual([
      { type: 'reasoning_text', text: 'must not reach provider runtime' },
    ]);
    expect(capturedBody.input[1].encrypted_content).toBeNull();
    expect(capturedBody.input[1].summary).toEqual([{ type: 'summary_text', text: 'summary stays' }]);
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
      tools: [
        { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
        {
          type: 'custom',
          name: 'apply_patch',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition:
              'start: begin_patch hunk+ end_patch\n'
              + 'begin_patch: "*** Begin Patch" LF\n'
              + 'end_patch: "*** End Patch" LF?\n'
          },
        },
      ],
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

  test('direct submit_tool_outputs hits native upstream submit endpoint instead of plain /responses', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-submit-tool-outputs-endpoint',
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

    let capturedUrl: string | undefined;
    let capturedBody: any;
    let capturedHeaders: Record<string, string> | undefined;
    provider.httpClient = {
      postStream: async (url: string, body: any, headers: Record<string, string>) => {
        capturedUrl = url;
        capturedBody = body;
        capturedHeaders = headers;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      response_id: 'resp_submit_direct_1',
      tool_outputs: [{ call_id: 'call_submit_direct_1', output: 'ok' }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        __responsesDirectPassthrough: true
      }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedUrl).toBe('https://example.invalid/v1/responses/resp_submit_direct_1/submit_tool_outputs');
    expect(capturedHeaders?.Accept).toBe('text/event-stream');
    expect(capturedBody).toEqual({
      tool_outputs: [{ call_id: 'call_submit_direct_1', output: 'ok' }],
      stream: true
    });
    expect(capturedBody.response_id).toBeUndefined();
  });

  test('passes Responses stream transport timeouts into provider SSE transport config', async () => {
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

    let capturedStreamConfig: { idleTimeoutMs?: number; headersTimeoutMs?: number } | undefined;
    provider.httpClient = {
      postStream: async (_url: string, _body: any, _headers: Record<string, string>, streamConfig?: { idleTimeoutMs?: number; headersTimeoutMs?: number }) => {
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
      metadata: {
        entryEndpoint: '/v1/responses',
        providerStreamNoContentTimeoutMs: 75,
        providerStreamHeadersTimeoutMs: 240_000
      }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedStreamConfig).toEqual({ idleTimeoutMs: 75, headersTimeoutMs: 240_000 });
  });

  test('direct passthrough no-content timeout ignores keepalive-only SSE traffic', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-semantic-no-content-timeout',
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
      postStream: async () => {
        const stream = new PassThrough();
        const interval = setInterval(() => {
          stream.write(': keepalive\n\n');
        }, 5);
        interval.unref?.();
        stream.on('close', () => clearInterval(interval));
        stream.on('error', () => clearInterval(interval));
        return stream;
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        providerStreamNoContentTimeoutMs: 40
      }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      code: 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT'
    });
  });

  test('direct passthrough content-idle timeout ignores keepalive after first semantic frame', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-semantic-content-idle-timeout',
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
      postStream: async () => {
        const stream = new PassThrough();
        queueMicrotask(() => {
          stream.write('event: response.created\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] }
          })}\n\n`);
          stream.write('event: response.output_item.added\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.output_item.added',
            item: { id: 'rs_1', type: 'reasoning', content: [], summary: [] },
            output_index: 0
          })}\n\n`);
        });
        const interval = setInterval(() => {
          stream.write(': keepalive\n\n');
        }, 5);
        interval.unref?.();
        stream.on('close', () => clearInterval(interval));
        stream.on('error', () => clearInterval(interval));
        return stream;
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        providerStreamNoContentTimeoutMs: 40,
        providerStreamContentIdleTimeoutMs: 40
      }
    });

    const result = await provider.sendRequestInternal(inbound) as { sseStream: NodeJS.ReadableStream };
    const passthrough = result.sseStream;
    passthrough.resume();
    const [error] = (await once(passthrough, 'error')) as [Error & { code?: string }];
    expect(error.message).toContain('UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT');
    expect(error.code).toBe('UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT');
  });

  test('direct passthrough semantic frames reset content-idle timer and allow terminal completion', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-semantic-idle-control',
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
      postStream: async () => {
        const stream = new PassThrough();
        setTimeout(() => {
          stream.write('event: response.created\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_ok', object: 'response', status: 'in_progress', output: [] }
          })}\n\n`);
        }, 0);
        setTimeout(() => {
          stream.write('event: response.output_item.added\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.output_item.added',
            item: { id: 'msg_ok', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
            output_index: 0
          })}\n\n`);
        }, 10);
        setTimeout(() => {
          stream.write('event: response.output_text.delta\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.output_text.delta',
            item_id: 'msg_ok',
            content_index: 0,
            delta: 'hello'
          })}\n\n`);
        }, 20);
        setTimeout(() => {
          stream.write('event: response.completed\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_ok', object: 'response', status: 'completed', output: [] }
          })}\n\n`);
        }, 30);
        setTimeout(() => {
          stream.write('event: response.done\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.done',
            response: { id: 'resp_ok', object: 'response', status: 'completed', output: [] }
          })}\n\n`);
          stream.end();
        }, 40);
        return stream;
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        providerStreamNoContentTimeoutMs: 50,
        providerStreamContentIdleTimeoutMs: 50
      }
    });

    const result = await provider.sendRequestInternal(inbound) as { sseStream: NodeJS.ReadableStream };
    const passthrough = result.sseStream;
    let text = '';
    for await (const chunk of passthrough as AsyncIterable<Buffer | string>) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    expect(text).toContain('event: response.completed');
    expect(text).toContain('event: response.done');
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

  test('maps direct HTTP 200 text/html streaming fallback to malformed provider error before SSE bridge', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-text-html-fallback',
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
      postStreamOrResponse: async () => ({
        kind: 'response',
        responseKind: 'text',
        response: {
          data: '<!doctype html><html><body>wrong upstream</body></html>',
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html; charset=utf-8' },
          url: 'https://example.invalid/v1/responses'
        }
      })
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
      statusCode: 200,
      status: 200,
      code: 'MALFORMED_RESPONSE'
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

  test('applies provider-configured error mapping before throwing direct SSE upstream errors', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-configured-error-mapping',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'XLC',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://xlapis.com/v1', endpoint: '/responses' },
        extensions: {
          errorMapping: {
            rules: [
              {
                origin: {
                  status: 400,
                  error: {
                    type: 'server_error',
                    messageContains: 'All available accounts exhausted'
                  }
                },
                to: {
                  status: 429,
                  code: 'HTTP_429',
                  message: 'All available accounts exhausted'
                }
              }
            ]
          }
        }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => {
        const error = Object.assign(
          new Error('HTTP 400: {"error":{"message":"All available accounts exhausted","type":"server_error","param":"","code":null}}'),
          {
            status: 400,
            statusCode: 400,
            code: 'HTTP_400',
            response: {
              data: {
                error: {
                  code: 'HTTP_400',
                  status: 400
                }
              }
            }
          }
        );
        throw error;
      }
    };

    const inbound = {
      model: 'deepseek-v4-pro',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      providerId: 'XLC',
      providerKey: 'XLC.key2.deepseek-v4-pro',
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true },
      extensions: config.config.extensions
    } as any);

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'HTTP_429',
      message: 'All available accounts exhausted',
      response: {
        data: {
          error: {
            code: 'HTTP_429',
            status: 429,
            message: 'All available accounts exhausted'
          }
        }
      }
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
    for await (const chunk of result.sseStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).not.toContain('event: codex.rate_limits');
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('resp_ok');
  });
});
