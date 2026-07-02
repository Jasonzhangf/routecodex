import { __requestExecutorTestables } from '../../../../../src/server/runtime/http-server/request-executor.js';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const { resolveRequestExecutorPipelineAttempt } = __requestExecutorTestables;

describe('resolveRequestExecutorPipelineAttempt excluded provider guard', () => {
  it('does not mark a narrowed current-only routePool authoritative after prior exclusions', () => {
    const narrowedCurrentOnly = __requestExecutorTestables.resolveRoutePoolAuthoritativeForRetry({
      routingDecision: {
        routeName: 'tools/gateway-priority-5555-priority-tools',
        routePool: ['minimax.key1.MiniMax-M3']
      },
      routePoolForAttempt: ['minimax.key1.MiniMax-M3'],
      routeTiersForAttempt: [{ targets: ['minimax.key1.MiniMax-M3'] }],
      defaultTierAvailable: false,
      excludedProviderKeys: new Set<string>(['spark.key1.gpt-5.3-codex-spark'])
    });
    const trueSingletonLastProvider = __requestExecutorTestables.resolveRoutePoolAuthoritativeForRetry({
      routingDecision: {
        routeName: 'tools/gateway-priority-5555-priority-tools',
        routePool: ['minimax.key1.MiniMax-M3']
      },
      routePoolForAttempt: ['minimax.key1.MiniMax-M3'],
      routeTiersForAttempt: [{ targets: ['minimax.key1.MiniMax-M3'] }],
      defaultTierAvailable: false,
      excludedProviderKeys: new Set<string>()
    });

    expect(narrowedCurrentOnly).toBe(false);
    expect(trueSingletonLastProvider).toBe(true);
  });

  it('does not mark a singleton priority tier authoritative when later route tiers exist', () => {
    const firstTierSingleton = __requestExecutorTestables.resolveRoutePoolAuthoritativeForRetry({
      routingDecision: {
        routeName: 'tools/gateway-priority-5555-priority-tools',
        routePool: ['spark.key1.gpt-5.3-codex-spark']
      },
      routePoolForAttempt: ['spark.key1.gpt-5.3-codex-spark'],
      routeTiersForAttempt: [
        { targets: ['spark.key1.gpt-5.3-codex-spark'] },
        { targets: ['minimax.key1.MiniMax-M3'] }
      ],
      defaultTierAvailable: false,
      excludedProviderKeys: new Set<string>()
    });

    expect(firstTierSingleton).toBe(false);
  });

  it('fails fast when VR reselects an excluded provider without an alternative', () => {
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
    })).toThrow('Virtual router reselected excluded provider primary.key1.gpt-5.5');

    expect(Array.from(excludedProviderKeys)).toEqual([providerKey]);
  });

  it('fails fast when VR reselects an excluded provider even with alternatives remaining', () => {
    const providerKey = 'primary.key1.gpt-5.5';
    const alternativeProviderKey = 'secondary.key1.gpt-5.5';
    const excludedProviderKeys = new Set<string>([providerKey]);
    const lastError = Object.assign(new Error('HTTP 502: upstream failed'), {
      code: 'HTTP_502',
      statusCode: 502
    });

    expect(() => resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-excluded-provider-reselected-with-alternative',
      providerRequestId: 'provider-req-excluded-provider-reselected-with-alternative',
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
          pool: [providerKey, alternativeProviderKey],
          routePool: [providerKey, alternativeProviderKey]
        },
        processMode: 'chat',
        metadata: {}
      },
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-excluded-provider-reselected-with-alternative',
      clientAbortSignal: undefined,
      initialRoutePool: [providerKey, alternativeProviderKey],
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
    })).toThrow('Virtual router reselected excluded provider primary.key1.gpt-5.5');

    expect(Array.from(excludedProviderKeys)).toEqual([providerKey]);
  });

  it('allows reselecting an excluded provider only when config proves it is the last provider', () => {
    const providerKey = 'primary.key1.gpt-5.5';
    const excludedProviderKeys = new Set<string>([providerKey]);
    const resolved = resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-excluded-provider-verified-last-provider',
      providerRequestId: 'provider-req-excluded-provider-verified-last-provider',
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
          routeName: 'default',
          providerProtocol: 'openai-chat',
          pool: [providerKey],
          routePool: [providerKey]
        },
        processMode: 'chat',
        metadata: {}
      },
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-excluded-provider-verified-last-provider',
      clientAbortSignal: undefined,
      initialRoutePool: [providerKey],
      routeTiersForAttempt: [{ targets: [providerKey] }],
      defaultRouteTiersForAttempt: [],
      excludedProviderKeys,
      lastError: Object.assign(new Error('HTTP 502: upstream failed'), {
        code: 'HTTP_502',
        statusCode: 502
      }),
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
    });

    expect(resolved.kind).toBe('resolved');
    expect(resolved.target?.providerKey).toBe(providerKey);
    expect(Array.from(excludedProviderKeys)).toEqual([providerKey]);
  });

  it('does not reject VR hits when selected target protocol requires relay conversion', () => {
    const providerKey = 'minimax.key1.MiniMax-M3';
    const metadataForAttempt: Record<string, unknown> = {};
    MetadataCenter.attach(metadataForAttempt);

    const resolved = resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-cross-protocol-vr-hit',
      providerRequestId: 'provider-req-cross-protocol-vr-hit',
      attempt: 1,
      metadataForAttempt,
      pipelineResult: {
        providerPayload: { model: 'MiniMax-M3', messages: [] },
        target: {
          providerKey,
          providerType: 'anthropic',
          outboundProfile: 'anthropic-messages',
          runtimeKey: providerKey
        },
        routingDecision: {
          routeName: 'default',
          providerProtocol: 'openai-responses',
          pool: [providerKey],
          routePool: [providerKey]
        },
        processMode: 'chat',
        metadata: {}
      },
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-cross-protocol-vr-hit',
      clientAbortSignal: undefined,
      initialRoutePool: null,
      excludedProviderKeys: new Set<string>(),
      lastError: undefined,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: () => ({
        errorCode: 'HTTP_502',
        upstreamCode: 'HTTP_502',
        reason: 'unused'
      }),
      hubStartedAtMs: Date.now(),
      pipelineLabel: 'hub.pipeline'
    });

    expect(resolved.kind).toBe('resolved');
    expect(resolved.target?.providerKey).toBe(providerKey);
    expect(MetadataCenter.read(metadataForAttempt)?.readRuntimeControl().providerProtocol).toBe('openai-responses');
  });
});
