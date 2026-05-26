import { __requestExecutorTestables } from '../../../../src/server/runtime/http-server/request-executor';

describe('request-executor windsurf route pool selection', () => {
  test('uses routingDiagnostics full pool when routingDecision pool is singleton', () => {
    const plan = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-windsurf-routing-diagnostics-full-pool',
      providerRequestId: 'req-windsurf-routing-diagnostics-full-pool',
      attempt: 1,
      metadataForAttempt: {},
      pipelineResult: {
        requestId: 'req-windsurf-routing-diagnostics-full-pool',
        metadata: {},
        providerPayload: { body: { model: 'gpt-5.4-medium' } },
        target: {
          providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium',
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: 'windsurf.ws-pro-1',
          processMode: 'standard'
        },
        routingDecision: { routeName: 'thinking', pool: ['windsurf.ws-pro-1.gpt-5.4-medium'] },
        routingDiagnostics: {
          routeName: 'thinking',
          poolId: 'gateway-priority-5520-thinking',
          pool: [
            'windsurf.ws-pro-1.gpt-5.4-medium',
            'windsurf.ws-pro-2.gpt-5.4-medium',
            'windsurf.ws-pro-3.gpt-5.4-medium'
          ]
        },
        processMode: 'standard'
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'req-windsurf-routing-diagnostics-full-pool',
      clientAbortSignal: undefined,
      initialRoutePool: null,
      excludedProviderKeys: new Set<string>(),
      lastError: Object.assign(new Error('Your weekly usage quota has been exhausted.'), {
        code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
        upstreamCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
        statusCode: 429,
        status: 429,
        rateLimitKind: 'daily_limit',
        quotaScope: 'weekly',
        quotaReason: 'windsurf_weekly_exhausted'
      }),
      blockingRecoverableRouteHoldState: null,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: __requestExecutorTestables.extractRetryErrorSnapshot,
      hubStartedAtMs: Date.now() - 10,
      pipelineLabel: 'hub'
    });

    expect(plan).toEqual({
      kind: 'resolved',
      mergedMetadata: expect.any(Object),
      mergedClientHeaders: undefined,
      routePoolForAttempt: [
        'windsurf.ws-pro-1.gpt-5.4-medium',
        'windsurf.ws-pro-2.gpt-5.4-medium',
        'windsurf.ws-pro-3.gpt-5.4-medium'
      ],
      providerPayload: { body: { model: 'gpt-5.4-medium' } },
      target: expect.objectContaining({ providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium' }),
      initialRoutePool: [
        'windsurf.ws-pro-1.gpt-5.4-medium',
        'windsurf.ws-pro-2.gpt-5.4-medium',
        'windsurf.ws-pro-3.gpt-5.4-medium'
      ]
    });
  });
});
