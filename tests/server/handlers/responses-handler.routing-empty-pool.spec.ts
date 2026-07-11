import express from 'express';
import { jest } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { HubRequestExecutor } from '../../../src/server/runtime/http-server/request-executor.js';
import { StatsManager } from '../../../src/server/runtime/http-server/stats-manager.js';
import {
  buildMetadataCenterTransportSnapshot,
  writeMetadataCenterSlot
} from '../../../src/server/runtime/http-server/metadata-center/dualwrite-api.js';
import { bootstrapVirtualRouterConfig } from '../../../src/modules/llmswitch/bridge/routing-integrations.js';
import { NativeHubPipelineTestWrapper as HubPipeline } from '../../helpers/native-hub-pipeline-test-wrapper.js';

const TEST_RUNTIME_CONTROL_WRITER = {
  module: 'tests/server/handlers/responses-handler.routing-empty-pool.spec.ts',
  symbol: 'buildResponsesExecutorInput',
  stage: 'test_native_responses_request'
} as const;

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
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
      },
      image: {
        id: 'image',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://image',
        auth: { type: 'apikey', apiKey: 'image-key' },
        models: { 'gpt-image-test': {} }
      }
    },
    routing: {
      default: [
        {
          id: 'default-priority',
          mode: 'priority',
          targets: ['primary.gpt-test', 'secondary.gpt-test']
        }
      ],
      image: [
        {
          id: 'image-priority',
          mode: 'priority',
          targets: ['image.gpt-image-test']
        }
      ]
    }
  };
}

function buildAnthropicVirtualRouterConfig() {
  return {
    providers: {
      mimo: {
        id: 'mimo',
        enabled: true,
        type: 'anthropic',
        baseURL: 'mock://mimo',
        auth: { type: 'apikey', apiKey: 'mimo-key' },
        models: { 'mimo-v2.5': {} }
      }
    },
    routing: {
      tools: [
        {
          id: 'tools-priority',
          mode: 'priority',
          targets: ['mimo.mimo-v2.5']
        }
      ],
      default: [
        {
          id: 'default-priority',
          mode: 'priority',
          targets: ['mimo.mimo-v2.5']
        }
      ]
    }
  };
}

function buildResponsesExecutorInput(input: any): any {
  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
    ? input.body as Record<string, unknown>
    : {};
  const routeHint = typeof body.model === 'string' && body.model === 'gpt-image-test' ? 'image' : 'default';
  const requestId = typeof input.requestId === 'string' && input.requestId.trim()
    ? input.requestId.trim()
    : (typeof input.id === 'string' && input.id.trim() ? input.id.trim() : 'req_responses_handler_test');
  const metadata =
    input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown>
      : {};
  const sessionId = typeof metadata.sessionId === 'string' && metadata.sessionId.trim()
    ? metadata.sessionId.trim()
    : `sess_${requestId}`;
  const runtimeControl = {
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    routeHint
  };
  Object.assign(metadata, {
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    routeHint,
    sessionId
  });
  for (const [key, value] of Object.entries(runtimeControl)) {
    writeMetadataCenterSlot({
      target: metadata,
      family: 'runtime_control',
      key,
      value,
      writer: TEST_RUNTIME_CONTROL_WRITER,
      reason: 'test native responses runtime control'
    });
  }
  const metadataCenterSnapshot = buildMetadataCenterTransportSnapshot(metadata);
  return {
    ...input,
    requestId,
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    payload: body,
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    metadata,
    metadataCenterSnapshot
  };
}

describe('responses handler virtual-router empty-pool guard', () => {
  it('retries HTTP /v1/responses when provider SSE stream terminates during bridge materialization', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerCalls: string[] = [];
    const createTerminatingStream = () => new Readable({
      read() {
        this.push('data: {"id":"chatcmpl_red","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
        this.destroy(new Error('terminated'));
      }
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
                return { status: 200, data: { mode: 'sse', sseStream: createTerminatingStream() } };
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
                return {
                  status: 200,
                  data: {
                    id: 'chatcmpl_ok',
                    object: 'chat.completion',
                    model: 'gpt-test',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok_from_secondary' }, finish_reason: 'stop' }]
                  }
                };
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
      getHubPipeline: () => pipeline.getNativeHandle() as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(buildResponsesExecutorInput(input)),
        errorHandling: null
      })
    );

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    const previousBase = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '4';
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = '1';
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hi' })
        });
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).toContain('ok_from_secondary');
        expect(providerCalls).toEqual(['primary', 'secondary']);
      });
    } finally {
      pipeline.dispose();
      if (previousAttempts === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      if (previousBase === undefined) delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
      else process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = previousBase;
    }
  });

  it('reroutes HTTP /v1/responses after primary provider 503 instead of retrying the same provider', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerCalls: string[] = [];

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
                throw Object.assign(new Error('HTTP 503: primary temporarily unavailable'), {
                  statusCode: 503,
                  code: 'HTTP_503'
                });
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
                return {
                  status: 200,
                  data: {
                    id: 'resp_ok_503_reroute',
                    object: 'response',
                    status: 'completed',
                    model: 'gpt-test',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok_from_secondary_503' }] }]
                  }
                };
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
      getHubPipeline: () => pipeline.getNativeHandle() as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(buildResponsesExecutorInput(input)),
        errorHandling: null
      })
    );

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    const previousBase = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '4';
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = '1';
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-test', input: 'hi' })
        });
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).toContain('ok_from_secondary_503');
        expect(providerCalls).toEqual(['primary', 'secondary']);
      });
    } finally {
      pipeline.dispose();
      if (previousAttempts === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      if (previousBase === undefined) delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
      else process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = previousBase;
    }
  });

  it('does not treat client stopMessage metadata as internal runtime control at /v1/responses boundary', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildAnthropicVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerPayloads: Array<Record<string, unknown>> = [];
    const executor = new HubRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string) => artifacts.targetRuntime?.[providerKey ?? '']?.runtimeKey,
        getHandleByRuntimeKey: (runtimeKey?: string) => runtimeKey === 'mimo.key1'
          ? {
              runtimeKey: 'mimo.key1',
              providerId: 'mimo',
              providerType: 'anthropic',
              providerFamily: 'anthropic',
              providerProtocol: 'anthropic-messages',
              runtime: { runtimeKey: 'mimo.key1' },
              instance: {
                initialize: async () => undefined,
                cleanup: async () => undefined,
                processIncoming: async (payload: Record<string, unknown>) => {
                  providerPayloads.push(payload);
                  return {
                    status: 200,
                    data: {
                      id: 'msg_test_1',
                      type: 'message',
                      role: 'assistant',
                      model: 'mimo-v2.5',
                      content: [{ type: 'text', text: 'ok' }],
                      stop_reason: 'end_turn'
                    }
                  };
                }
              }
            }
          : undefined,
        getHandleByProviderKey: () => undefined,
        disposeAll: async () => undefined,
        initialize: async () => undefined
      },
      getHubPipeline: () => pipeline.getNativeHandle() as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(buildResponsesExecutorInput(input)),
        errorHandling: null
      })
    );

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'mimo-v2.5',
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'read files' }]
              }
            ],
            tools: [
              {
                type: 'function',
                name: 'exec_command',
                parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
              }
            ],
            tool_choice: 'auto',
            metadata: { stopMessageEnabled: false }
          })
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.output_text ?? JSON.stringify(body)).toContain('ok');
        expect(providerPayloads).toHaveLength(1);
        expect(JSON.stringify(providerPayloads[0])).not.toContain('stopMessageEnabled');
      });
    } finally {
      pipeline.dispose();
    }
  });

  it('does not treat client excludedProviderKeys metadata as internal routing exclusion at /v1/responses boundary', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => {
          const result = await pipeline.execute(buildResponsesExecutorInput(input));
          return {
            status: 200,
            body: {
              selected_provider_key: result.target?.providerKey,
              route_name: result.routingDecision?.routeName
            },
            metadata: result.metadata
          };
        },
        errorHandling: null
      })
    );

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-test',
            input: 'hi',
            metadata: {
              excludedProviderKeys: ['primary.key1.gpt-test', 'secondary.key1.gpt-test']
            }
          })
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.selected_provider_key).toBeDefined();
        expect(body.route_name).toBe('default');
      });
    } finally {
      pipeline.dispose();
    }
  });

  it('keeps default route non-empty under busy marks and surfaces downstream runtime resolution failure instead of empty-pool', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    pipeline.getVirtualRouter().markConcurrencyScopeBusy('primary.key1.gpt-test');
    pipeline.getVirtualRouter().markConcurrencyScopeBusy('secondary.key1.gpt-test');
    const logStages: Array<{ stage: string; details: Record<string, unknown> }> = [];
    const executor = new HubRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: () => undefined,
        getHandleByRuntimeKey: () => undefined,
        getHandleByProviderKey: () => undefined,
        disposeAll: async () => undefined,
        initialize: async () => undefined
      },
      getHubPipeline: () => pipeline.getNativeHandle() as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: (stage: string, _requestId: string, details: Record<string, unknown>) => {
        logStages.push({ stage, details });
      },
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(buildResponsesExecutorInput(input)),
        errorHandling: null
      })
    );

    const previousBackoffBase = process.env.RCC_429_BACKOFF_BASE_MS;
    const previousBackoffMax = process.env.RCC_429_BACKOFF_MAX_MS;
    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    const previousProviderBase = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
    process.env.RCC_429_BACKOFF_BASE_MS = '1';
    process.env.RCC_429_BACKOFF_MAX_MS = '8';
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '2';
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = '1';
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-test',
            input: 'hi'
          })
        });
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.error?.message).toBe('Upstream provider error');
        expect(body.error?.code).not.toBe('PROVIDER_NOT_AVAILABLE');
        expect(logStages.some((entry) => entry.stage === 'provider.route_pool_cooldown_wait')).toBe(false);
      });
    } finally {
      if (previousBackoffBase === undefined) delete process.env.RCC_429_BACKOFF_BASE_MS;
      else process.env.RCC_429_BACKOFF_BASE_MS = previousBackoffBase;
      if (previousBackoffMax === undefined) delete process.env.RCC_429_BACKOFF_MAX_MS;
      else process.env.RCC_429_BACKOFF_MAX_MS = previousBackoffMax;
      if (previousAttempts === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      if (previousProviderBase === undefined) delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
      else process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = previousProviderBase;
      pipeline.dispose();
    }
  }, 15_000);

  it('normalizes chat image_url parts to responses input_image before provider wire send', async () => {
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerPayloads: Array<Record<string, unknown>> = [];
    const executor = new HubRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string) => artifacts.targetRuntime?.[providerKey ?? '']?.runtimeKey,
        getHandleByRuntimeKey: (runtimeKey?: string) => runtimeKey === 'image.key1'
          ? {
              runtimeKey,
              providerId: 'image',
              providerType: 'openai',
              providerFamily: 'openai',
              providerProtocol: 'openai-responses',
              runtime: { runtimeKey },
              instance: {
                initialize: async () => undefined,
                cleanup: async () => undefined,
                processIncoming: async (payload: Record<string, unknown>) => {
                  providerPayloads.push(payload);
                  return {
                    status: 200,
                    data: {
                      id: 'resp_image_1',
                      object: 'response',
                      status: 'completed',
                      model: 'gpt-test',
                      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
                    }
                  };
                }
              }
            }
          : undefined,
        getHandleByProviderKey: () => undefined,
        disposeAll: async () => undefined,
        initialize: async () => undefined
      },
      getHubPipeline: () => pipeline.getNativeHandle() as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(buildResponsesExecutorInput(input)),
        errorHandling: null
      })
    );

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-image-test',
            input: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'describe image' },
                  { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
                ]
              }
            ]
          })
        });

        expect(response.status).toBe(200);
        expect(providerPayloads).toHaveLength(1);
        const input = providerPayloads[0].input as Array<Record<string, unknown>>;
        const content = input[0].content as Array<Record<string, unknown>>;
        expect(content[0]).toMatchObject({ type: 'input_text', text: 'describe image' });
        expect(content[1]).toMatchObject({ type: 'input_image', image_url: 'data:image/png;base64,AAA' });
        expect(JSON.stringify(providerPayloads[0])).not.toContain('"type":"image_url"');
      });
    } finally {
      pipeline.dispose();
    }
  });
});
