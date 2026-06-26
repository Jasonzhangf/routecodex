import { describe, expect, it, jest } from '@jest/globals';

const detectRetryableEmptyAssistantResponseMock = jest.fn(() => null);

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/executor/request-executor-response-contract.js',
  () => ({
    detectAssistantSanitizationPlaceholder: jest.fn(() => null),
    detectRetryableEmptyAssistantResponse: detectRetryableEmptyAssistantResponseMock,
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
  it('raises missing required tool call for responses completed payload that only contains reasoning summary', async () => {
    jest.resetModules();
    detectRetryableEmptyAssistantResponseMock.mockResolvedValueOnce({
      marker: 'responses_missing_required_tool_call',
      reason: 'responses status=completed but output text/tool_calls are empty'
    });
    const { processSuccessfulProviderResponse } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'required'
      },
      messages: [
        {
          role: 'user',
          content: 'continue'
        }
      ]
    };

    await expect(processSuccessfulProviderResponse(baseArgs({
      requestSemantics,
      converted: {
        status: 200,
        body: {
          status: 'completed',
          output_text: '',
          output: [
            {
              type: 'reasoning',
              summary: [
                {
                  type: 'summary_text',
                  text: 'I have all the information I need. Let me create the hook file now.'
                }
              ]
            }
          ]
        }
      } as any
    }) as any)).rejects.toMatchObject({
      code: 'MISSING_REQUIRED_TOOL_CALL',
      statusCode: 502,
      requestExecutorProviderErrorStage: 'host.response_contract'
    });
  });

  it('escalates 200 business error payloads into provider failure path instead of treating them as success', async () => {
    const { processSuccessfulProviderResponse } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    await expect(processSuccessfulProviderResponse(baseArgs({
      providerProtocol: 'openai-responses',
      normalized: {
        status: 200,
        body: {
          error: {
            message: 'usage limit exceeded, weekly usage limit reached',
            code: 'PROVIDER_STATUS_2056',
            statusCode: 2056
          }
        }
      } as any,
      converted: {
        status: 200,
        body: {
          error: {
            message: 'usage limit exceeded, weekly usage limit reached',
            code: 'PROVIDER_STATUS_2056',
            statusCode: 2056
          }
        }
      } as any
    }) as any)).rejects.toMatchObject({
      statusCode: 429,
      code: 'HTTP_429_2056',
      upstreamCode: 'PROVIDER_STATUS_2056',
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

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

  it('keeps final successful attempt usage instead of summing failed-attempt prompt totals', async () => {
    const { processSuccessfulProviderResponse } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    const result = await processSuccessfulProviderResponse(baseArgs({
      providerProtocol: 'openai-responses',
      aggregatedUsage: {
        prompt_tokens: 58575,
        completion_tokens: 415,
        total_tokens: 58990,
        cache_read_input_tokens: 29056
      },
      providerUsageFallback: {
        prompt_tokens: 29385,
        completion_tokens: 415,
        total_tokens: 29800,
        cache_read_input_tokens: 29056
      },
      converted: {
        status: 200,
        body: {
          data: {
            usage: {
              input_tokens: 29385,
              input_tokens_details: { cached_tokens: 29056 },
              output_tokens: 415,
              total_tokens: 29800
            }
          }
        }
      } as any,
      attempt: 3
    }) as any);

    expect(result.aggregatedUsage).toEqual({
      prompt_tokens: 29385,
      completion_tokens: 415,
      total_tokens: 29800,
      cache_read_input_tokens: 29056,
      cache_creation_input_tokens: undefined
    });
  });
});
