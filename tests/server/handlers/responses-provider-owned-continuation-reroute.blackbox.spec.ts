import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/server/runtime/http-server/executor/request-executor-native-retry-policy.js', () => ({
  resolveRequestExecutorNativeRetryPolicy: jest.fn((input: {
    classification?: string;
    isStreamingRequest?: boolean;
    hostContractFailure?: boolean;
    forceExcludeCurrentProviderOnRetry?: boolean;
    promptTooLong?: boolean;
    existingExclusion?: boolean;
  }) => {
    if (input.hostContractFailure) return { excludeCurrentProvider: false, reason: 'host_contract_failure' };
    if (input.forceExcludeCurrentProviderOnRetry || input.existingExclusion) return { excludeCurrentProvider: true, reason: 'existing_exclusion' };
    if (input.isStreamingRequest && input.classification === 'recoverable' && !input.promptTooLong) {
      return { excludeCurrentProvider: true, reason: 'streaming_recoverable_pre_response' };
    }
    return { excludeCurrentProvider: false, reason: 'preserve_existing_policy' };
  })
}));

const express = (await import('express')).default;
const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
const { HubRequestExecutor } = await import('../../../src/server/runtime/http-server/request-executor.js');
const { StatsManager } = await import('../../../src/server/runtime/http-server/stats-manager.js');
const { bootstrapVirtualRouterConfig, getHubPipelineCtor } = await import('../../../src/modules/llmswitch/bridge.js');

type AddressInfo = import('node:net').AddressInfo;
type HubPipelineCtor = new (config: any) => {
  execute: (request: any) => Promise<any>;
  dispose: () => void;
};

async function withServer<T>(app: ReturnType<typeof express>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<ReturnType<typeof express>['listen']>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function buildVirtualRouterConfig() {
  return {
    providers: {
      primary: {
        id: 'primary',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://primary',
        auth: { type: 'apikey', apiKey: 'primary-key' },
        models: { 'gpt-test': {} }
      },
      secondary: {
        id: 'secondary',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://secondary',
        auth: { type: 'apikey', apiKey: 'secondary-key' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      default: [{ id: 'default-priority', mode: 'priority', targets: ['primary.gpt-test', 'secondary.gpt-test'] }]
    }
  };
}

describe('responses provider-owned continuation reroute blackbox', () => {
  it('does not replay tool-result continuations on an alternative provider after provider.send throws', async () => {
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerCalls: string[] = [];
    const providerError = Object.assign(new Error('HTTP 502: SSE_TO_JSON_ERROR'), {
      statusCode: 502,
      code: 'SSE_TO_JSON_ERROR',
      upstreamCode: 'upstream_error'
    });

    const runtimeManager = {
      resolveRuntimeKey: (providerKey?: string) => artifacts.targetRuntime?.[providerKey ?? '']?.runtimeKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => {
        if (runtimeKey === 'primary.key1') {
          return {
            runtimeKey: 'primary.key1',
            providerId: 'primary',
            providerType: 'openai',
            providerFamily: 'openai',
            providerProtocol: 'openai-responses',
            runtime: { runtimeKey: 'primary.key1' },
            instance: {
              initialize: async () => undefined,
              cleanup: async () => undefined,
              processIncoming: async () => {
                providerCalls.push('primary');
                throw providerError;
              }
            }
          };
        }
        if (runtimeKey === 'secondary.key1') {
          return {
            runtimeKey: 'secondary.key1',
            providerId: 'secondary',
            providerType: 'openai',
            providerFamily: 'openai',
            providerProtocol: 'openai-responses',
            runtime: { runtimeKey: 'secondary.key1' },
            instance: {
              initialize: async () => undefined,
              cleanup: async () => undefined,
              processIncoming: async () => {
                providerCalls.push('secondary');
                return { status: 200, data: { id: 'resp_should_not_be_used', output_text: 'wrong_provider' } };
              }
            }
          };
        }
        return undefined;
      },
      getHandleByProviderKey: () => undefined,
      disposeAll: async () => undefined,
      initialize: async () => undefined
    };
    const executor = new HubRequestExecutor({
      runtimeManager,
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({ errorHandlingCenter: { handleError: async () => undefined } }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) => handleResponses(req, res, {
      executePipeline: async (input) => executor.execute(input),
      errorHandling: null
    }));

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '4';
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-test',
            stream: true,
            input: [
              { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{}' },
              { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
            ]
          })
        });
        const text = await response.text();
        expect(response.status).toBe(502);
        expect(text).toContain('Upstream provider error');
        expect(providerCalls).toEqual(['primary']);
      });
    } finally {
      pipeline.dispose();
      if (previousAttempts === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
    }
  });
});
