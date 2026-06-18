import { describe, expect, it, jest } from '@jest/globals';

describe('buildProviderExecutionSuccessResult metadata propagation', () => {
  it('preserves mergedMetadata onto final PipelineExecutionResult so downstream handler SSE restore can read client contract fields', async () => {
    const { buildProviderExecutionSuccessResult } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    const result = buildProviderExecutionSuccessResult({
      converted: {
        status: 200,
        body: { sseStream: { pipe: () => undefined } }
      } as any,
      providerKey: 'test.key1',
      providerModel: 'gpt-5.4',
      routeName: 'test-route',
      routingPoolId: 'test-pool',
      finishReason: 'stop',
      aggregatedUsage: undefined,
      cumulativeExternalLatencyMs: 1,
      cumulativeTrafficWaitMs: 0,
      cumulativeClientInjectWaitMs: 0,
      attempt: 1,
      requestStartedAtMs: Date.now(),
      providerRequestId: 'provider-req-1',
      inputRequestId: 'input-req-1',
      mergedMetadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
        __raw_request_body: {
          model: 'gpt-5.3-codex',
          reasoning: { effort: 'high' }
        }
      },
      readString: (value: unknown) => typeof value === 'string' ? value : undefined,
      readHubStageTop: () => undefined,
      readHubDecodeBreakdown: () => ({ sseDecodeMs: 0, codecDecodeMs: 0 })
    });

    expect(result.metadata).toMatchObject({
      clientModelId: 'gpt-5.3-codex',
      originalModelId: 'gpt-5.3-codex'
    });
    expect((result.metadata as any)?.__raw_request_body).toMatchObject({
      model: 'gpt-5.3-codex',
      reasoning: { effort: 'high' }
    });
  });
});
