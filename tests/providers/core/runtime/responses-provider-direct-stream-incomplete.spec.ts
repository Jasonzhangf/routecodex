import { Readable } from 'node:stream';

import { describe, expect, it, jest } from '@jest/globals';

import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => undefined }),
  reportProviderErrorToRouterPolicy: async () => undefined,
  reportProviderSuccessToRouterPolicy: async () => undefined,
  createResponsesSseToJsonConverter: async () => ({
    convertSseToJson: async () => ({ id: 'unused' }),
  }),
  convertResponsesRequestToChatNative: (payload: Record<string, unknown>) => ({
    request: {
      model: payload.model,
      messages: [],
      tools: payload.tools,
    },
  }),
  sanitizeProviderOutboundPayload: async (input: { payload: Record<string, unknown> }) => input.payload,
  writeSnapshotViaHooks: async () => undefined,
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

describe('ResponsesProvider direct SSE terminal validation', () => {
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
    let text = '';
    for await (const chunk of response.sseStream) {
      text += String(chunk);
    }
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.completed');
  });
});
