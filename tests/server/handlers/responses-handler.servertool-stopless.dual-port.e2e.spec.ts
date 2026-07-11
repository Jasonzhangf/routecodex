import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/state-integrations.js', () => ({
  loadRoutingInstructionStateSync: jest.fn(() => undefined),
  saveRoutingInstructionStateAsync: jest.fn(() => undefined),
  saveRoutingInstructionStateSync: jest.fn(() => undefined),
  extractSessionIdentifiersFromMetadata: jest.fn((metadata?: Record<string, unknown>) => ({
    sessionId: typeof metadata?.session_id === 'string' ? metadata.session_id : undefined,
    conversationId: typeof metadata?.conversation_id === 'string' ? metadata.conversation_id : undefined
  })),
  extractContinuationContextSessionIdentifiersFromMetadata: jest.fn(() => ({})),
  getStatsCenterSafe: jest.fn(() => ({ getSnapshot: () => null, recordProviderUsage: () => {} })),
  getLlmsStatsSnapshot: jest.fn(() => null)
}));

const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
const { bootstrapVirtualRouterConfig } = await import('../../../src/modules/llmswitch/bridge/routing-integrations.js');
const { NativeHubPipelineTestWrapper: HubPipeline } = await import('../../../tests/helpers/native-hub-pipeline-test-wrapper.js');
const { createRequestExecutor } = await import('../../../src/server/runtime/http-server/request-executor.js');
const { StatsManager } = await import('../../../src/server/runtime/http-server/stats-manager.js');
const { MetadataCenter } = await import('../../../src/server/runtime/http-server/metadata-center/metadata-center.js');

type ProviderHandle = {
  runtimeKey: string;
  providerId: string;
  providerKey: string;
  providerType: 'anthropic' | 'openai';
  providerFamily: 'anthropic' | 'openai';
  providerProtocol: 'anthropic-messages' | 'openai-chat' | 'openai-responses';
  runtime: {
    runtimeKey: string;
    providerId: string;
    keyAlias: string;
    providerType: 'anthropic' | 'openai';
    endpoint: string;
    auth: { type: string; value: string };
    outboundProfile: 'anthropic-messages' | 'openai-chat' | 'openai-responses';
  };
  instance: {
    initialize: () => Promise<void>;
    cleanup: () => Promise<void>;
    processIncoming: (payload: Record<string, unknown>) => Promise<unknown>;
  };
};

function buildExecCommandTool(): Record<string, unknown> {
  return {
    type: 'function',
    name: 'exec_command',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string' },
        workdir: { type: 'string' }
      },
      required: ['cmd'],
      additionalProperties: false
    }
  };
}

function buildOpenaiResponsesText(text: string, idSuffix: string): Record<string, unknown> {
  return {
    id: `resp_${idSuffix}`,
    object: 'response',
    status: 'completed',
    model: 'gpt-test',
    output: [{
      id: `msg_${idSuffix}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    }],
    output_text: text,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    finish_reason: 'stop'
  };
}

function isolateSessionDir(label: string): void {
  const dir = path.join(
    process.cwd(),
    '.tmp',
    'jest-servertool-blackbox',
    `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  process.env.ROUTECODEX_SESSION_DIR = dir;
}

function createProviderHandle(args: {
  runtimeKey: string;
  providerKey: string;
  providerType: 'anthropic' | 'openai';
  providerProtocol: 'anthropic-messages' | 'openai-chat' | 'openai-responses';
  processIncoming: (payload: Record<string, unknown>) => Promise<unknown>;
}): ProviderHandle {
  return {
    runtimeKey: args.runtimeKey,
    providerId: args.providerKey,
    providerKey: args.providerKey,
    providerType: args.providerType,
    providerFamily: args.providerType,
    providerProtocol: args.providerProtocol,
    runtime: {
      runtimeKey: args.runtimeKey,
      providerId: args.providerKey,
      keyAlias: args.providerKey,
      providerType: args.providerType,
      endpoint: `mock://${args.providerType}`,
      auth: { type: 'apiKey', value: 'mock' },
      outboundProfile: args.providerProtocol
    },
    instance: {
      initialize: async () => {},
      cleanup: async () => {},
      processIncoming: args.processIncoming
    }
  };
}

function createSingleHandleRuntimeManager(handle: ProviderHandle) {
  return {
    resolveRuntimeKey: (providerKey?: string) => (providerKey ? handle.runtimeKey : undefined),
    getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === handle.runtimeKey ? handle : undefined),
    getHandleByProviderKey: (providerKey?: string) => (providerKey === handle.providerKey ? handle : undefined)
  };
}

async function listenApp(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson(
  baseUrl: string,
  routePath: string,
  body: unknown
): Promise<{ status: number; payload: any; text: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text ? JSON.parse(text) : null,
    text,
    headers: response.headers
  };
}

async function runStoplessDualPortScenario(args: {
  sessionId: string;
  processIncoming: (payload: Record<string, unknown>) => Promise<unknown>;
}): Promise<{
  result: { status: number; payload: any; text: string; headers: Headers };
  capturedProviderPayload: Record<string, unknown> | undefined;
  logStages: Array<{ stage: string; requestId: string; details?: Record<string, unknown> }>;
}> {
  isolateSessionDir(args.sessionId);
  const artifacts = await bootstrapVirtualRouterConfig({
    providers: {
      primary: {
        id: 'primary',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://primary',
        auth: { type: 'apikey', apiKey: 'mock' },
        responses: { streaming: 'always' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      thinking: [{ id: 'thinking-primary', targets: ['primary.gpt-test'] }],
      default: [{ id: 'default-primary', mode: 'priority', targets: ['primary.gpt-test'] }]
    }
  } as any) as any;
  const pipeline = new HubPipeline({
    virtualRouter: artifacts.config,
    policy: { mode: 'off' }
  });
  const pipelineHandle = (pipeline as unknown as { handle?: string }).handle;
  if (!pipelineHandle) {
    throw new Error('native hub pipeline test wrapper did not expose handle');
  }
  const logStages: Array<{ stage: string; requestId: string; details?: Record<string, unknown> }> = [];

  let capturedProviderPayload: Record<string, unknown> | undefined;
  const processIncoming = jest.fn(async (payload: Record<string, unknown>) => {
    capturedProviderPayload = payload;
    return args.processIncoming(payload);
  });

  const handle = createProviderHandle({
    runtimeKey: 'primary.key1',
    providerKey: 'primary.gpt-test',
    providerType: 'openai',
    providerProtocol: 'openai-responses',
    processIncoming
  });

  const executor = createRequestExecutor({
    runtimeManager: createSingleHandleRuntimeManager(handle),
    getHubPipeline: () => pipelineHandle as any,
    getModuleDependencies: () => ({
      errorHandlingCenter: {
        handleError: jest.fn(async () => ({ success: true }))
      }
    } as any),
    logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => {
      logStages.push({ stage, requestId, details });
    },
    stats: new StatsManager()
  });

  const app = express();
  app.use(express.json({ limit: '512kb' }));
  const executePipeline = jest.fn((input) => {
    const pipelineMetadata = {
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    } as Record<string, unknown>;
    const center = MetadataCenter.attach(pipelineMetadata);
    center.writeRuntimeControl(
      'stopless',
      {
        triggerHint: 'no_schema',
        schemaFeedback: {
          reasonCode: 'stop_schema_missing',
          missingFields: ['stopreason', 'reason']
        }
      },
      {
        module: 'tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts',
        symbol: 'runStoplessDualPortScenario',
        stage: 'test'
      },
      'test stopless runtime control'
    );
    center.writeRuntimeControl(
      'stopMessageState',
      {
        stopMessageText: '继续执行 stopless 双端口黑盒验证',
        stopMessageMaxRepeats: 3,
        stopMessageUsed: 0,
        stopMessageStageMode: 'on'
      },
      {
        module: 'tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts',
        symbol: 'runStoplessDualPortScenario',
        stage: 'test'
      },
      'test stopless runtime control'
    );
    center.writeRuntimeControl(
      'stopMessageEnabled',
      true,
      {
        module: 'tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts',
        symbol: 'runStoplessDualPortScenario',
        stage: 'test'
      },
      'test stopless runtime control'
    );
    return executor.execute({
      ...(input as any),
      metadata: {
        ...pipelineMetadata
      }
    });
  });
  app.post('/v1/responses', (req, res) => {
    void handleResponses(req as any, res as any, {
      executePipeline,
      errorHandling: null
    });
  });

  const { server, baseUrl } = await listenApp(app);
  try {
    const result = await fetchJson(baseUrl, '/v1/responses', {
      model: 'gpt-test',
      stream: false,
      metadata: {
        session_id: args.sessionId,
        conversation_id: args.sessionId
      },
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行 stopless 双端口黑盒验证。<**stopless:on**>' }]
        }
      ],
      messages: [
        {
          role: 'user',
          content: '继续执行 stopless 双端口黑盒验证。<**stopless:on**>'
        }
      ],
      tools: [buildExecCommandTool()]
    });
    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(logStages.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(['provider.runtime_resolve.start', 'provider.send.start'])
    );
    return { result, capturedProviderPayload, logStages };
  } finally {
    await closeServer(server);
    pipeline.dispose?.();
  }
}

describe('responses HTTP servertool stopless dual-port e2e', () => {
  it('injects reasoningStop into provider outbound and projects reasoningStop exec_command on no-schema stop', async () => {
    const { result, capturedProviderPayload, logStages } = await runStoplessDualPortScenario({
      sessionId: 'sess-stopless-dual-port-no-schema',
      processIncoming: async () => ({
        status: 200,
        data: buildOpenaiResponsesText('阶段完成：审计已结束。', 'stopless_dual_port_no_schema_1')
      })
    });

    expect(result.status).toBe(200);
    expect(capturedProviderPayload).toBeDefined();
    const providerPayloadJson = JSON.stringify(capturedProviderPayload);
    expect(providerPayloadJson).toContain('reasoningStop');
    expect(providerPayloadJson).toContain('stopreason');
    expect(providerPayloadJson).not.toContain('"runtime_control"');
    expect(providerPayloadJson).not.toContain('"__rt"');
    expect(logStages.some((entry) => entry.stage === 'provider.send.start')).toBe(true);

    expect(String(providerPayloadJson)).toContain('Use this tool when you stop, pause, or need another turn.');
    expect(String(providerPayloadJson)).toContain('Provide stop schema as JSON arguments');
    expect(String(providerPayloadJson)).toContain('stopreason values: 0=finished, 1=blocked, 2=continue_needed');
    expect(String(result.payload?.output_text || '')).toContain('阶段完成：审计已结束。');
  });

  it('projects wrong-schema stop into reasoningStop exec_command with invalid_schema guidance', async () => {
    const { result, capturedProviderPayload } = await runStoplessDualPortScenario({
      sessionId: 'sess-stopless-dual-port-wrong-schema',
      processIncoming: async () => ({
        status: 200,
        data: buildOpenaiResponsesText(
          [
            '<rcc_stop_schema>',
            '{"stopreason":"oops","reason":"想停","has_evidence":1,"evidence":"log"}',
            '</rcc_stop_schema>'
          ].join('\n'),
          'stopless_dual_port_wrong_schema_1'
        )
      })
    });

    expect(result.status).toBe(200);
    expect(capturedProviderPayload).toBeDefined();
    const providerPayloadJson = JSON.stringify(capturedProviderPayload);
    expect(providerPayloadJson).toContain('reasoningStop');
    expect(providerPayloadJson).toContain('stopreason');

    expect(String(providerPayloadJson)).toContain('Use this tool when you stop, pause, or need another turn.');
    expect(String(providerPayloadJson)).toContain('Provide stop schema as JSON arguments');
    expect(String(providerPayloadJson)).toContain('stopreason values: 0=finished, 1=blocked, 2=continue_needed');
    const resultText = JSON.stringify(result.payload);
    expect(resultText).toContain('exec_command');
    expect(resultText).toContain('routecodex hook run reasoningStop');
    expect(resultText).toContain('invalid_schema');
  });

  it('allows terminal stop when provider returns a valid terminal stop schema', async () => {
    const { result, capturedProviderPayload } = await runStoplessDualPortScenario({
      sessionId: 'sess-stopless-dual-port-valid-terminal',
      processIncoming: async () => ({
        status: 200,
        data: buildOpenaiResponsesText(
          [
            '已完成在线验证。',
            '<rcc_stop_schema>',
            '{"stopreason":0,"reason":"已完成双端口 stopless 验证","has_evidence":1,"evidence":"dual-port e2e passed","issue_cause":"none","excluded_factors":"none","diagnostic_order":"request->provider->client","done_steps":"validated provider outbound and client outbound","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"terminal stop schema can close directly"}',
            '</rcc_stop_schema>'
          ].join('\n'),
          'stopless_dual_port_valid_terminal_1'
        )
      })
    });

    expect(result.status).toBe(200);
    expect(capturedProviderPayload).toBeDefined();
    const providerPayloadJson = JSON.stringify(capturedProviderPayload);
    expect(providerPayloadJson).toContain('reasoningStop');
    expect(providerPayloadJson).toContain('Use this tool when you stop, pause, or need another turn.');
    expect(providerPayloadJson).toContain('Provide stop schema as JSON arguments');
    expect(providerPayloadJson).toContain('stopreason values: 0=finished, 1=blocked, 2=continue_needed');

    const functionCall = result.payload?.output?.find((item: any) => item?.type === 'function_call');
    expect(functionCall).toBeUndefined();
    expect(String(result.payload?.output_text || '')).toContain('已完成在线验证');
    expect(String(result.payload?.output_text || '')).not.toContain('<rcc_stop_schema>');
    expect(JSON.stringify(result.payload)).not.toContain('reasoningStop');
  });
});
