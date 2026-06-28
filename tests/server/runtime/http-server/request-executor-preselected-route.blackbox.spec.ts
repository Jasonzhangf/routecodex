import { jest } from '@jest/globals';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types';

jest.unstable_mockModule(
  '../../../../src/server/runtime/http-server/executor/provider-response-utils.js',
  () => ({
    extractProviderModel: (payload?: Record<string, unknown>) =>
      typeof payload?.model === 'string' ? payload.model : undefined,
    extractClientModelId: (
      _metadata: Record<string, unknown>,
      originalRequest?: Record<string, unknown>
    ) => typeof originalRequest?.model === 'string' ? originalRequest.model : undefined,
    buildProviderLabel: (providerKey?: string, model?: string) =>
      providerKey && model ? `${providerKey}.${model}` : providerKey ?? model,
    extractResponseStatus: (response: unknown) =>
      response && typeof response === 'object' && typeof (response as { status?: unknown }).status === 'number'
        ? (response as { status: number }).status
        : undefined,
    normalizeProviderResponse: (response: unknown) => ({
      status: response && typeof response === 'object' && typeof (response as { status?: unknown }).status === 'number'
        ? (response as { status: number }).status
        : undefined,
      body: response && typeof response === 'object' && 'data' in response
        ? (response as { data?: unknown }).data
        : response
    }),
    resolveRequestSemantics: () => undefined,
    describeRequestSemanticsResolution: () => ({ mocked: true })
  })
);

jest.unstable_mockModule(
  '../../../../src/server/runtime/http-server/executor/request-executor-request-semantics.js',
  () => ({
    hasRequestedToolsInSemantics: jest.fn(async () => false),
    isRequiredToolCallTurn: jest.fn(async () => false),
    isProviderNativeResumeContinuation: jest.fn(async () => false),
    isToolResultFollowupTurn: jest.fn(async () => false)
  })
);

const { createRequestExecutor } = await import('../../../../src/server/runtime/http-server/request-executor');
const { StatsManager } = await import('../../../../src/server/runtime/http-server/stats-manager');
const { MetadataCenter } = await import('../../../../src/server/runtime/http-server/metadata-center/metadata-center.js');

function buildHandle(providerKey: string, processFn: () => Promise<unknown>): ProviderHandle {
  return {
    runtimeKey: providerKey,
    providerId: providerKey,
    providerType: 'openai',
    providerFamily: 'openai',
    providerProtocol: 'openai-chat',
    runtime: {
      runtimeKey: providerKey,
      providerId: providerKey,
      keyAlias: providerKey,
      providerType: 'openai',
      endpoint: 'https://example.invalid',
      auth: { type: 'oauth' },
      outboundProfile: 'openai-chat'
    },
    instance: {
      async initialize() {},
      async cleanup() {},
      processIncoming: processFn
    }
  };
}

describe('request executor preselectedRoute retry boundary', () => {
  test('clears router-direct relay preselectedRoute before provider failure reroute so Hub can reselect tokenrelay', async () => {
    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '3';
    const providerA = 'XLC.key1.glm-5.2';
    const providerB = 'tokenrelay.key1.deepseek-v4-pro';
    const routePool = [providerA, providerB, 'XLC.key2.deepseek-v4-pro'];

    const failingProcess = jest.fn(async () => {
      throw Object.assign(new Error('model_not_found'), {
        statusCode: 503,
        status: 503,
        code: 'model_not_found',
        upstreamCode: 'HTTP_503',
        retryable: true
      });
    });
    const successProcess = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_tokenrelay_after_reroute',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'tokenrelay-ok' }]
          }
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
    }));

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, failingProcess)],
      [providerB, buildHandle(providerB, successProcess)]
    ]);
    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const selectedProviders: string[] = [];
    const preselectedSeenByAttempt: boolean[] = [];
    const pipeline = {
      execute: jest.fn(async (input: any, metadataArg?: Record<string, unknown>) => {
        const metadata = metadataArg && typeof metadataArg === 'object' ? metadataArg : input?.metadata;
        const runtimeControl = MetadataCenter.read(metadata)?.readRuntimeControl();
        const preselected = runtimeControl?.preselectedRoute as { target?: { providerKey?: string } } | undefined;
        const excluded = new Set<string>(
          Array.isArray(metadata?.excludedProviderKeys) ? metadata.excludedProviderKeys : []
        );
        const providerKey = preselected?.target?.providerKey
          ?? (excluded.has(providerA) ? providerB : providerA);
        selectedProviders.push(providerKey);
        preselectedSeenByAttempt.push(Boolean(preselected));
        return {
          requestId: input.id,
          processedRequest: {
            model: 'gpt-5.4',
            messages: [{ role: 'user', content: 'ping tokenrelay' }]
          },
          standardizedRequest: {
            model: 'gpt-5.4',
            messages: [{ role: 'user', content: 'ping tokenrelay' }]
          },
          providerPayload: {
            model: providerKey === providerB ? 'deepseek-v4-pro' : 'glm-5.2',
            messages: [{ role: 'user', content: 'ping tokenrelay' }]
          },
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey,
            modelId: providerKey === providerB ? 'deepseek-v4-pro' : 'glm-5.2'
          },
          routingDecision: {
            routeName: 'thinking',
            pool: [providerKey],
            routePool,
            reason: 'thinking:user-input'
          },
          processMode: 'standard',
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const metadata: Record<string, unknown> = {};
    MetadataCenter.attach(metadata).writeRuntimeControl(
      'preselectedRoute',
      {
        target: {
          providerKey: providerA,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: providerA,
          modelId: 'glm-5.2'
        },
        decision: {
          routeName: 'thinking',
          pool: [providerA],
          routePool,
          reason: 'thinking:user-input'
        },
        diagnostics: {}
      },
      {
        module: 'tests/server/runtime/http-server/request-executor-preselected-route.blackbox.spec.ts',
        symbol: 'preselectedRoute relay retry blackbox',
        stage: 'test'
      },
      'simulate router-direct target_outbound_profile_requires_hub_relay handoff'
    );

    try {
      const executor = createRequestExecutor({
        runtimeManager,
        getHubPipeline: () => pipeline as any,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      });

      const result = await executor.execute({
        requestId: 'req-router-direct-relay-preselected-reroute',
        entryEndpoint: '/v1/chat/completions',
        body: {
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'ping tokenrelay' }]
        },
        headers: {},
        metadata
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(selectedProviders).toEqual([providerA, providerB]);
      expect(preselectedSeenByAttempt).toEqual([true, false]);
      expect(failingProcess).toHaveBeenCalledTimes(1);
      expect(successProcess).toHaveBeenCalledTimes(1);
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      const secondPipelineInput = pipeline.execute.mock.calls[1]?.[0] as { metadata?: Record<string, unknown> } | undefined;
      const secondMetadata = secondPipelineInput?.metadata;
      expect(secondMetadata?.excludedProviderKeys).toEqual([providerA]);
      expect(MetadataCenter.read(secondMetadata)?.readRuntimeControl().preselectedRoute).toBeUndefined();
    } finally {
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
    }
  });
});
