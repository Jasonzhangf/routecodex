import { jest } from '@jest/globals';

const mockLookupResponsesContinuationByResponseId = jest.fn();
const mockResumeResponsesConversation = jest.fn();

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/state-integrations.js', () => ({
  extractContinuationContextSessionIdentifiersFromMetadata: () => ({}),
  extractSessionIdentifiersFromMetadata: () => ({}),
  loadRoutingInstructionStateSync: () => null,
  saveRoutingInstructionStateAsync: () => {},
  saveRoutingInstructionStateSync: () => {},
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/snapshot-recorder.js', () => ({
  createSnapshotRecorder: jest.fn(async () => ({ record: () => {} })),
  resetSnapshotRecorderErrorsampleStateForTests: jest.fn(),
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/provider-response-converter-host.js', () => ({
  convertProviderResponse: jest.fn(async () => ({ body: { ok: true } })),
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  buildResponsesJsonFromSseStreamWithNative: jest.fn(async () => ({})),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearAllResponsesConversationState: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  clearUnresolvedResponsesConversationRequests: jest.fn(async () => undefined),
  finalizeResponsesConversationRequestRetention: jest.fn(async () => undefined),
  lookupResponsesContinuationByResponseId: jest.fn(async (...args: unknown[]) =>
    mockLookupResponsesContinuationByResponseId(...args)
  ),
  materializeLatestResponsesContinuationByScope: jest.fn(async () => null),
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({ loaded: [] })),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  recordResponsesResponseForRequest: jest.fn(async () => undefined),
  reportProviderErrorToRouterPolicy: jest.fn(async (event: unknown) => event),
  reportProviderSuccessToRouterPolicy: jest.fn(async (event: unknown) => event),
  resetResponsesConversationStateForRestartSimulation: jest.fn(async () => undefined),
  resumeLatestResponsesContinuationByScope: jest.fn(async () => null),
  resumeResponsesConversation: jest.fn(async (...args: unknown[]) =>
    mockResumeResponsesConversation(...args)
  ),
  writeSnapshotViaHooks: jest.fn(async () => {}),
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-conversation-store-host.js', () => ({
  lookupResponsesContinuationByResponseId: mockLookupResponsesContinuationByResponseId,
  resumeResponsesConversation: mockResumeResponsesConversation,
  captureResponsesRequestContext: jest.fn(),
  recordResponsesResponse: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  materializeLatestResponsesContinuationByScope: jest.fn(() => null),
  resumeLatestResponsesContinuationByScope: jest.fn(() => null),
  rebindResponsesConversationRequestId: jest.fn(),
  clearAllResponsesConversationState: jest.fn(),
  resetResponsesConversationStateForRestartSimulation: jest.fn(),
  clearUnresolvedResponsesConversationRequests: jest.fn(() => 0),
}));

const express = (await import('express')).default;
const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
const { HubRequestExecutor } = await import('../../../src/server/runtime/http-server/request-executor.js');
const { StatsManager } = await import('../../../src/server/runtime/http-server/stats-manager.js');
const { bootstrapVirtualRouterConfig } = await import('../../../src/modules/llmswitch/bridge/routing-integrations.js');
const { NativeHubPipelineTestWrapper: HubPipeline } = await import('../../../tests/helpers/native-hub-pipeline-test-wrapper.js');

type AddressInfo = import('node:net').AddressInfo;
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

async function executePreparedPipelineInput(executor: InstanceType<typeof HubRequestExecutor>, input: any) {
  if (input.hubBody === undefined) {
    return executor.execute(input);
  }
  const { hubBody, ...withoutHubBody } = input;
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  metadata.__raw_request_body = input.body;
  return executor.execute({
    ...withoutHubBody,
    body: hubBody,
    metadata,
  });
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
        responses: { streaming: 'always' },
        models: { 'gpt-test': {} }
      },
      secondary: {
        id: 'secondary',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://secondary',
        auth: { type: 'apikey', apiKey: 'secondary-key' },
        responses: { streaming: 'always' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      default: [{ id: 'default-priority', mode: 'priority', targets: ['primary.gpt-test', 'secondary.gpt-test'] }]
    }
  };
}

describe('responses provider-owned continuation reroute blackbox', () => {
  beforeEach(() => {
    mockLookupResponsesContinuationByResponseId.mockReset();
    mockResumeResponsesConversation.mockReset();
  });

  it('does not replay tool-result continuations on an alternative provider after provider.send throws', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerCalls: string[] = [];
    const providerError = Object.assign(new Error('HTTP 502: SSE_TO_JSON_ERROR'), {
      statusCode: 502,
      code: 'SSE_TO_JSON_ERROR',
      upstreamCode: 'upstream_error'
    });

    const runtimeManager = {
      resolveRuntimeKey: (providerKey?: string) => {
        if (providerKey && artifacts.targetRuntime?.[providerKey]?.runtimeKey) {
          return artifacts.targetRuntime[providerKey].runtimeKey;
        }
        if (typeof providerKey === 'string' && providerKey.includes('primary')) {
          return 'primary.key1';
        }
        if (typeof providerKey === 'string' && providerKey.includes('secondary')) {
          return 'secondary.key1';
        }
        return undefined;
      },
      getHandleByRuntimeKey: (runtimeKey?: string) => {
        if (typeof runtimeKey === 'string' && runtimeKey.includes('primary')) {
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
        if (typeof runtimeKey === 'string' && runtimeKey.includes('secondary')) {
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
      getHandleByProviderKey: (providerKey?: string) => {
        if (typeof providerKey === 'string' && providerKey.includes('primary')) {
          return runtimeManager.getHandleByRuntimeKey?.('primary.key1');
        }
        if (typeof providerKey === 'string' && providerKey.includes('secondary')) {
          return runtimeManager.getHandleByRuntimeKey?.('secondary.key1');
        }
        return undefined;
      },
      disposeAll: async () => undefined,
      initialize: async () => undefined
    };
    const executor = new HubRequestExecutor({
      runtimeManager,
      getHubPipeline: () => (pipeline as unknown as { handle: string }).handle,
      getModuleDependencies: () => ({ errorHandlingCenter: { handleError: async () => undefined } }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) => handleResponses(req, res, {
      executePipeline: async (input) => executePreparedPipelineInput(executor, input),
      errorHandling: null
    }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => handleResponses(req, res, {
      executePipeline: async (input) => executePreparedPipelineInput(executor, input),
      errorHandling: null
    }, {
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      responseIdFromPath: (req as any).params.id
    }));

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '4';
    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      responseId: 'resp_prev_1',
      providerKey: 'primary.key1.gpt-test',
      continuationOwner: 'direct',
      entryKind: 'responses'
    });
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses/resp_prev_1/submit_tool_outputs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-test',
            tool_outputs: [
              { call_id: 'call_1', output: 'ok' }
            ]
          })
        });
        const text = await response.text();
        expect(response.status).toBe(502);
        expect(JSON.parse(text)).toMatchObject({
          error: {
            message: 'SSE_TO_JSON_ERROR',
            code: 'upstream_error',
            upstream_status: 502,
          },
        });
        expect(providerCalls).toEqual(['primary']);
      });
    } finally {
      pipeline.dispose();
      if (previousAttempts === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
    }
  });

  it('reroutes relay submit_tool_outputs continuation away from responsesResume.providerKey on 429', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerCalls: string[] = [];
    const primaryError = Object.assign(new Error('HTTP 429: provider busy'), {
      statusCode: 429,
      code: 'bad_response_status_code',
      upstreamCode: 'bad_response_status_code'
    });

    const runtimeManager = {
      resolveRuntimeKey: (providerKey?: string) => {
        if (providerKey && artifacts.targetRuntime?.[providerKey]?.runtimeKey) {
          return artifacts.targetRuntime[providerKey].runtimeKey;
        }
        if (typeof providerKey === 'string' && providerKey.includes('primary')) {
          return 'primary.key1';
        }
        if (typeof providerKey === 'string' && providerKey.includes('secondary')) {
          return 'secondary.key1';
        }
        return undefined;
      },
      getHandleByRuntimeKey: (runtimeKey?: string) => {
        if (typeof runtimeKey === 'string' && runtimeKey.includes('primary')) {
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
                throw primaryError;
              }
            }
          };
        }
        if (typeof runtimeKey === 'string' && runtimeKey.includes('secondary')) {
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
                return { status: 200, data: { id: 'resp_secondary_1', output_text: 'rerouted_provider_ok' } };
              }
            }
          };
        }
        return undefined;
      },
      getHandleByProviderKey: (providerKey?: string) => {
        if (typeof providerKey === 'string' && providerKey.includes('primary')) {
          return runtimeManager.getHandleByRuntimeKey?.('primary.key1');
        }
        if (typeof providerKey === 'string' && providerKey.includes('secondary')) {
          return runtimeManager.getHandleByRuntimeKey?.('secondary.key1');
        }
        return undefined;
      },
      disposeAll: async () => undefined,
      initialize: async () => undefined
    };
    const executor = new HubRequestExecutor({
      runtimeManager,
      getHubPipeline: () => (pipeline as unknown as { handle: string }).handle,
      getModuleDependencies: () => ({ errorHandlingCenter: { handleError: async () => undefined } }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) => handleResponses(req, res, {
      executePipeline: async (input) => executePreparedPipelineInput(executor, input),
      errorHandling: null
    }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => handleResponses(req, res, {
      executePipeline: async (input) => executePreparedPipelineInput(executor, input),
      errorHandling: null
    }, {
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      responseIdFromPath: (req as any).params.id
    }));

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '4';
    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      responseId: 'resp_prev_1',
      providerKey: 'primary.key1.gpt-test',
      continuationOwner: 'relay',
      entryKind: 'responses',
      fullInput: [
        {
          type: 'message',
          role: 'user',
          content: 'continue relay submit_tool_outputs reroute'
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"ok":true}'
        }
      ],
      restoredTools: [
        { type: 'function', name: 'exec_command' }
      ],
      fullInputItems: 3,
    });
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-test',
        previous_response_id: 'resp_prev_1',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'continue relay submit_tool_outputs reroute' }
            ]
          },
          {
            type: 'function_call',
            id: 'fc_call_1',
            call_id: 'call_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          },
          {
            type: 'function_call_output',
            id: 'fc_call_1',
            call_id: 'call_1',
            output: '{"ok":true}'
          }
        ],
      },
      meta: {
        restoredFromResponseId: 'resp_prev_1',
        providerKey: 'primary.key1.gpt-test',
        continuationOwner: 'relay',
        routeHint: 'thinking',
      },
    });
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses/resp_prev_1/submit_tool_outputs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stream: false,
            metadata: {
              responsesResume: {
                providerKey: 'primary.key1.gpt-test',
                restoredFromResponseId: 'resp_prev_1',
                previousRequestId: 'req_prev_1',
                toolOutputsDetailed: [
                  {
                    callId: 'call_1',
                    outputText: '{"ok":true}'
                  }
                ]
              }
            },
            tool_outputs: [
              { call_id: 'call_1', output: '{"ok":true}' }
            ],
          })
        });
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(providerCalls).toEqual(['primary', 'secondary']);
        expect(() => JSON.parse(text)).not.toThrow();
        expect(text).not.toContain('SSE stream missing from pipeline result');
      });
    } finally {
      pipeline.dispose();
      if (previousAttempts === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
    }
  });
});
