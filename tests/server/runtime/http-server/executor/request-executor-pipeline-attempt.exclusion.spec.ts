import { __requestExecutorTestables } from '../../../../../src/server/runtime/http-server/request-executor.js';

const { resolveRequestExecutorPipelineAttempt } = __requestExecutorTestables;

describe('resolveRequestExecutorPipelineAttempt excluded provider guard', () => {
  it('does not delete an excluded provider when VR reselects it without an alternative', () => {
    const providerKey = 'primary.key1.gpt-5.5';
    const excludedProviderKeys = new Set<string>([providerKey]);
    const lastError = Object.assign(new Error('HTTP 502: upstream failed'), {
      code: 'HTTP_502',
      statusCode: 502
    });

    expect(() => resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-excluded-provider-reselected',
      providerRequestId: 'provider-req-excluded-provider-reselected',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        providerPayload: { model: 'gpt-5.5', messages: [] },
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: providerKey
        },
        routingDecision: {
          routeName: 'tools/gateway-priority-5555-priority-tools',
          providerProtocol: 'openai-chat',
          pool: [providerKey]
        },
        processMode: 'chat',
        metadata: {}
      },
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-excluded-provider-reselected',
      clientAbortSignal: undefined,
      initialRoutePool: [providerKey],
      excludedProviderKeys,
      lastError,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: () => ({
        statusCode: 502,
        errorCode: 'HTTP_502',
        upstreamCode: 'HTTP_502',
        reason: 'HTTP 502: upstream failed'
      }),
      hubStartedAtMs: Date.now(),
      pipelineLabel: 'hub.pipeline'
    })).toThrow(lastError);

    expect(Array.from(excludedProviderKeys)).toEqual([providerKey]);
  });
});
