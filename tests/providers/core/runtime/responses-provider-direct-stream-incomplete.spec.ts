import { PassThrough, Readable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { buildLlmswitchNativeExportsFake } from '../../helpers/llmswitch-native-exports-fake.js';

const mockProviderErrorEvents: unknown[] = [];

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  reportProviderErrorToRouterPolicy: async (event: unknown) => {
    mockProviderErrorEvents.push(event);
  },
  reportProviderSuccessToRouterPolicy: async () => undefined,
  buildResponsesJsonFromSseStreamWithNative: async () => ({ status: 'completed', output: [] }),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  ...buildLlmswitchNativeExportsFake({
    convertResponsesRequestToChatNative: (payload: Record<string, unknown>) => ({
      request: {
        model: payload.model,
        messages: [],
        tools: payload.tools,
      },
    }),
    normalizeResponsesDirectCurrentRequestPayload: (input: { payload?: Record<string, unknown> }) => input.payload ?? {},
    sanitizeProviderOutboundPayload: async (input: { payload: Record<string, unknown> }) => input.payload,
    evaluateSingletonRoutePoolExhaustionNative: () => ({ exhausted: false }),
  }),
}));

const { ResponsesProvider } = await import('../../../../src/providers/core/runtime/responses-provider.js');

const deps: ModuleDependencies = {
  logger: { logModule: () => undefined },
} as unknown as ModuleDependencies;

function createProvider(): any {
  const config: OpenAIStandardConfig = {
    id: 'test-responses-direct-stream-incomplete',
    type: 'responses-http-provider',
    config: {
      providerType: 'responses',
      providerId: 'test',
      auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
      overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' },
    },
  } as unknown as OpenAIStandardConfig;
  const provider = new ResponsesProvider(config, deps) as any;
  provider.isInitialized = true;
  provider.snapshotPhase = async () => undefined;
  provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
  provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
  return provider;
}

async function readSseStreamText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return text;
}

describe('ResponsesProvider direct SSE terminal validation', () => {
  beforeEach(() => {
    mockProviderErrorEvents.length = 0;
  });

  it('rejects direct passthrough upstream SSE that terminates after lifecycle preamble only', async () => {
    const provider = createProvider();
    provider.httpClient = {
      postStream: async () => {
        const stream = new PassThrough();
        setImmediate(() => {
          stream.write(
            'event: response.created\n'
              + 'data: {"type":"response.created","response":{"id":"resp_preamble_only","status":"in_progress"}}\n\n'
          );
          setTimeout(() => {
            stream.destroy(Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }));
          }, 5).unref?.();
        });
        return stream;
      },
    };

    try {
      const response = await provider.processIncomingDirect({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        stream: true,
      });
      (response.sseStream as NodeJS.ReadableStream | undefined)?.on?.('error', () => undefined);
      throw new Error('direct passthrough returned a client stream before classifying preamble-only upstream termination');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'UPSTREAM_STREAM_TERMINATED',
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'provider.responses',
      });
    }
  });

  it('rejects direct passthrough upstream SSE that closes before response.completed', async () => {
    const provider = createProvider();
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: response.created\n'
          + 'data: {"type":"response.created","response":{"id":"resp_incomplete","status":"in_progress"}}\n\n',
        'event: response.reasoning_summary_text.delta\n'
          + 'data: {"type":"response.reasoning_summary_text.delta","delta":"partial"}\n\n',
      ]),
    };

    const response = await provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
    });

    await expect(readSseStreamText(response.sseStream)).rejects.toMatchObject({
      code: 'UPSTREAM_STREAM_INCOMPLETE',
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.responses',
    });
  });

  it('reports provider health when direct passthrough upstream SSE terminates after client streaming starts', async () => {
    const provider = createProvider();
    provider.httpClient = {
      postStream: async () => {
        const stream = new PassThrough();
        setImmediate(() => {
          stream.write(
            'event: response.created\n'
              + 'data: {"type":"response.created","response":{"id":"resp_stream_error_after_delta","status":"in_progress"}}\n\n'
          );
          stream.write(
            'event: response.output_text.delta\n'
              + 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
          );
          setTimeout(() => {
            stream.destroy(Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }));
          }, 5).unref?.();
        });
        return stream;
      },
    };

    const response = await provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
    });

    await expect(readSseStreamText(response.sseStream)).rejects.toMatchObject({
      code: 'UPSTREAM_STREAM_TERMINATED',
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.responses',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProviderErrorEvents).toHaveLength(1);
    expect(mockProviderErrorEvents[0]).toMatchObject({
      code: 'UPSTREAM_STREAM_TERMINATED',
      stage: 'provider.responses.stream',
      status: 502,
      recoverable: true,
      affectsHealth: true,
      details: {
        streamPhase: 'direct_passthrough_after_provider_return',
      },
    });
  });

  it('does not report provider health when client destroys direct passthrough SSE stream', async () => {
    const provider = createProvider();
    provider.httpClient = {
      postStream: async () => {
        const stream = new PassThrough();
        setImmediate(() => {
          stream.write(
            'event: response.created\n'
              + 'data: {"type":"response.created","response":{"id":"resp_client_close","status":"in_progress"}}\n\n'
          );
          stream.write(
            'event: response.output_text.delta\n'
              + 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
          );
        });
        return stream;
      },
    };

    const response = await provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
    });
    response.sseStream.on('error', () => undefined);
    response.sseStream.destroy(Object.assign(new Error('CLIENT_RESPONSE_CLOSED'), {
      code: 'CLIENT_DISCONNECTED',
      name: 'AbortError',
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProviderErrorEvents).toEqual([]);
  });

  it('rejects direct passthrough upstream SSE that ends with response.incomplete', async () => {
    const provider = createProvider();
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: response.created\n'
          + 'data: {"type":"response.created","response":{"id":"resp_incomplete","status":"in_progress"}}\n\n',
        'event: response.incomplete\n'
          + 'data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
      ]),
    };

    await expect(provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
    })).rejects.toMatchObject({
      code: 'UPSTREAM_STREAM_INCOMPLETE',
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.responses',
    });
  });

  it('returns replayable stream when direct passthrough upstream SSE reaches response.completed', async () => {
    const provider = createProvider();
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: response.created\n'
          + 'data: {"type":"response.created","response":{"id":"resp_ok","status":"in_progress"}}\n\n',
        'event: response.completed\n'
          + 'data: {"type":"response.completed","response":{"id":"resp_ok","status":"completed"}}\n\n',
      ]),
    };

    const response = await provider.processIncomingDirect({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
    });
    const text = await readSseStreamText(response.sseStream);
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.completed');
    expect(text).not.toContain('data: [DONE]');
  });
});
