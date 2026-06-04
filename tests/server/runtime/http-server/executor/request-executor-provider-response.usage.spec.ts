import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/executor/request-executor-response-contract.js',
  () => ({
    detectAssistantSanitizationPlaceholder: jest.fn(() => null),
    detectRetryableEmptyAssistantResponse: jest.fn(() => null),
    persistPayloadContractProviderSnapshots: jest.fn(async () => undefined)
  })
);

function baseArgs(overrides: Record<string, unknown>) {
  return {
    inputRequestId: 'req-usage-protocol',
    entryEndpoint: '/v1/responses',
    providerKey: 'test.key1',
    providerId: 'test',
    providerProtocol: 'openai-responses',
    providerPayload: {},
    normalized: { status: 200, body: { id: 'resp_usage' } } as any,
    converted: { status: 200, body: { id: 'resp_usage' } } as any,
    mergedMetadata: {},
    bypassTrafficGovernor: true,
    trafficGovernor: {} as any,
    runtimeKey: 'runtime:test',
    stats: { recordToolUsage: jest.fn() } as any,
    attempt: 1,
    logStage: () => undefined,
    logNonBlockingError: () => undefined,
    queuePayloadContractErrorsample: () => undefined,
    writeProviderSnapshot: async () => undefined,
    clearProviderTransportBackoff: () => undefined,
    ...overrides
  };
}

describe('processSuccessfulProviderResponse usage protocol accounting', () => {
  it('uses providerProtocol when extracting OpenAI Responses usage cache metrics', async () => {
    const { processSuccessfulProviderResponse } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    const result = await processSuccessfulProviderResponse(baseArgs({
      providerProtocol: 'openai-responses',
      converted: {
        status: 200,
        body: {
          data: {
            usage: {
              input_tokens: 306,
              input_tokens_details: { cached_tokens: 12 },
              output_tokens: 40,
              total_tokens: 346
            }
          }
        }
      } as any
    }) as any);

    expect(result.aggregatedUsage).toEqual({
      prompt_tokens: 306,
      completion_tokens: 40,
      total_tokens: 346,
      cache_read_input_tokens: 12,
      cache_creation_input_tokens: undefined
    });
  });

  it('preserves provider raw cache metrics when converted Responses payload only has client usage fields', async () => {
    const { processSuccessfulProviderResponse } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    const result = await processSuccessfulProviderResponse(baseArgs({
      providerProtocol: 'anthropic-messages',
      providerUsageFallback: {
        prompt_tokens: 188995,
        completion_tokens: 736,
        total_tokens: 189731,
        cache_read_input_tokens: 187776,
        cache_creation_input_tokens: undefined
      },
      converted: {
        status: 200,
        body: {
          usage: {
            input_tokens: 1219,
            input_tokens_details: { cached_tokens: 187776 },
            output_tokens: 736,
            total_tokens: 1955
          }
        }
      } as any
    }) as any);

    expect(result.aggregatedUsage).toEqual({
      prompt_tokens: 188995,
      completion_tokens: 736,
      total_tokens: 189731,
      cache_read_input_tokens: 187776,
      cache_creation_input_tokens: undefined
    });
  });
});
