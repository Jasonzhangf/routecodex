import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
  reportProviderErrorToRouterPolicy: async () => {},
  writeSnapshotViaHooks: async () => {},
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
  validateResponsesDirectToolShapeContractNative: () => ({ ok: true as const }),
  applyResponsesDirectRouteParamsOverrideNative: (input: {
    payload: Record<string, unknown>;
    routeParams?: Record<string, unknown>;
    providerDefaultModel?: string;
    requestReasoningEffort?: string;
  }) => {
    const next = structuredClone(input.payload);
    const routeModel = typeof input.routeParams?.model === 'string' ? input.routeParams.model.trim() : '';
    const providerDefaultModel = typeof input.providerDefaultModel === 'string' ? input.providerDefaultModel.trim() : '';
    if (routeModel || providerDefaultModel) {
      next.model = routeModel || providerDefaultModel;
    }
    const routeReasoningEffort =
      typeof input.routeParams?.reasoningEffort === 'string' ? input.routeParams.reasoningEffort.trim() : '';
    const topLevelReasoningEffort =
      typeof input.requestReasoningEffort === 'string' ? input.requestReasoningEffort.trim() : '';
    if (routeReasoningEffort || topLevelReasoningEffort) {
      const effort = routeReasoningEffort || topLevelReasoningEffort;
      next.reasoning_effort = effort;
      next.reasoning = { effort };
    }
    return next;
  },
  buildResponsesDirectPassthroughBodyNative: (payload: Record<string, unknown>) => {
    const next = structuredClone(payload);
    for (const key of Object.keys(next)) {
      if (key.startsWith('__')) {
        delete (next as Record<string, unknown>)[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(next, 'metadata')) {
      throw new Error('provider-runtime-error: metadata is not allowed in direct passthrough responses payload');
    }
    const model = typeof next.model === 'string' ? next.model.trim() : '';
    if (!model) {
      throw new Error('provider-runtime-error: missing model from direct passthrough responses payload');
    }
    next.model = model;
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
  test('fails fast when direct passthrough body contains metadata', async () => {
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
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    const inbound = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      metadata: { __responsesDirectPassthrough: true }
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: { __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow(/metadata is not allowed/);
  });

  test('strips reasoning.content before provider HTTP send for non-DeepSeek responses provider', async () => {
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
        const badReasoning = Array.isArray(body.input)
          && body.input.some((item: any) => item?.type === 'reasoning' && Array.isArray(item.content) && item.content.length > 0);
        if (badReasoning) {
          const error = new Error("HTTP 400: Invalid 'input[6].content': array too long") as Error & { status?: number; code?: string };
          error.status = 400;
          error.code = 'HTTP_400';
          throw error;
        }
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
    expect(capturedBody.input[1].type).toBe('reasoning');
    expect(capturedBody.input[1].content).toBeUndefined();
    expect(capturedBody.input[1].encrypted_content).toBeUndefined();
    expect(JSON.stringify(capturedBody)).not.toContain('must not reach provider runtime');
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
    expect(capturedBody.model).toBe('gpt-5.4');
    expect(capturedBody.previous_response_id).toBe('resp_prev_turn');
    expect(capturedBody.input).toEqual(inbound.input);
    expect(capturedBody.prompt_cache_key).toBe('cache-key-1');
    expect(capturedBody.tools).toEqual(inbound.tools);
    expect(capturedBody.tool_choice).toBe('auto');
    expect(capturedBody.instructions).toBe('keep-original-instructions');
    expect(capturedBody.metadata).toBeUndefined();
  });
});
