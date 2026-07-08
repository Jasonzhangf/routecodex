import { EventEmitter } from 'node:events';
import { describe, expect, it, jest } from '@jest/globals';
import { extractProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  buildMetadataCenterRustSnapshot,
  writeMetadataCenterSlot,
} from '../../../../src/server/runtime/http-server/metadata-center/dualwrite-api.js';
import {
  getClientConnectionAbortSignal,
  trackClientConnectionState,
} from '../../../../src/server/utils/client-connection-state.js';

const TEST_METADATA_WRITER = {
  module: 'tests/server/runtime/http-server/direct-server-contract.red.spec.ts',
  symbol: 'direct-server-contract',
  stage: 'test_setup',
} as const;

type NativeRouteMock = (request: Record<string, unknown>, metadata: Record<string, unknown>) => unknown;

let activeNativeRouteMock: NativeRouteMock | undefined;

const executeHubPipelineNativeMock = jest.fn(() => {
  throw new Error('router-direct test must not enter native HubPipeline execute');
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-integrations.js', () => ({
  bootstrapVirtualRouterConfig: jest.fn(async (input: Record<string, unknown>) => ({ config: input, targetRuntime: {} })),
  compileRouteCodexRuntimeManifest: jest.fn(async () => ({ pipelineRuntimeConfig: {}, virtualRouterBootstrapInput: {} })),
  compileRouteCodexRuntimeManifestSync: jest.fn(() => ({ pipelineRuntimeConfig: {}, virtualRouterBootstrapInput: {} })),
  collectRouteCodexV2ConfigSourceErrorsSync: jest.fn(() => []),
  normalizeRouteCodexV2RuntimeSourceSync: jest.fn((input: Record<string, unknown>) => input ?? {}),
  resolvePrimaryRouteCodexRoutingPolicyGroupSync: jest.fn(() => undefined),
  extractRouteCodexMaterializedProviderConfigsSync: jest.fn(() => null),
  materializeRouteCodexUserConfigFromManifestSync: jest.fn((userConfig: Record<string, unknown>) => userConfig ?? {}),
  buildRouteCodexProviderProfilesSync: jest.fn(() => ({})),
  buildRouteCodexForwarderProfilesSync: jest.fn(() => ({})),
  parseRouteCodexTomlRecord: jest.fn(async () => ({})),
  parseRouteCodexTomlRecordSync: jest.fn(() => ({})),
  serializeRouteCodexTomlRecord: jest.fn(async () => ''),
  serializeRouteCodexTomlRecordSync: jest.fn(() => ''),
  updateRouteCodexTomlStringScalarInTable: jest.fn(async () => ''),
  updateRouteCodexTomlStringScalarInTableSync: jest.fn(() => ''),
  decodeRouteCodexUserConfigTextSync: jest.fn(() => ({ format: 'toml', raw: '', parsed: {} })),
  decodeRouteCodexProviderConfigTextSync: jest.fn(() => ({ format: 'toml', raw: '', parsed: {} })),
  detectRouteCodexUserConfigFormatSync: jest.fn(() => 'toml'),
  detectRouteCodexProviderConfigFormatSync: jest.fn(() => 'toml'),
  writeRouteCodexUserConfigFileNativeSync: jest.fn(() => undefined),
  writeRouteCodexProviderConfigFileNativeSync: jest.fn(() => undefined),
  updateRouteCodexUserConfigStringScalarNativeSync: jest.fn(() => ''),
  loadRouteCodexConfigNativeSync: jest.fn(() => ({ configPath: '', userConfig: {}, providerProfiles: {} })),
  coerceRouteCodexProviderConfigV2: jest.fn(async (parsed: unknown) => parsed ?? null),
  coerceRouteCodexProviderConfigV2Sync: jest.fn((parsed: unknown) => parsed ?? null),
  planRouteCodexProviderConfigV2FilesSync: jest.fn(() => []),
  resolveRouteCodexProviderConfigV2IdentitySync: jest.fn((input: any) => ({ providerId: input?.dirId ?? 'provider', provider: input?.provider ?? {} })),
  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
  resolveRccUserDirNativeSync: jest.fn(() => '/tmp/.rcc'),
  resolveRccPathNativeSync: jest.fn((segments: string[] = []) => ['/tmp/.rcc', ...segments].join('/')),
  resolveRccSnapshotsDirNativeSync: jest.fn(() => '/tmp/.rcc/snapshots'),
  planAuthFileResolutionNativeSync: jest.fn((input: any) => ({ kind: 'literal', value: input?.keyId ?? '', cacheKey: input?.keyId ?? '' })),
  resolveAuthFileKeyNativeSync: jest.fn((input: any) => ({ kind: 'literal', value: input?.keyId ?? '', cacheKey: input?.keyId ?? '' })),
  planRouteCodexConfigLoaderPathsNativeSync: jest.fn((input: any) => ({ explicitPath: input?.explicitPath, providerRootDir: input?.routecodexProviderDir ?? input?.rccProviderDir })),
  planProviderConfigRootNativeSync: jest.fn((rootDir?: string) => ({ rootDir })),
  resolveRouteCodexConfigPathNativeSync: jest.fn(() => '/tmp/routecodex-test-config.toml'),
  createHubPipelineNative: jest.fn(() => 'mock_hub_pipeline_handle'),
  executeHubPipelineNative: executeHubPipelineNativeMock,
  updateHubPipelineVirtualRouterConfigNative: jest.fn(),
  updateHubPipelineEngineDepsNative: jest.fn(),
  routeHubPipelineVirtualRouterNative: jest.fn((_handle: string, request: Record<string, unknown>, metadata: Record<string, unknown>) => {
    if (!activeNativeRouteMock) {
      throw new Error('native HubPipeline VR route mock is not installed');
    }
    return activeNativeRouteMock(request, metadata);
  }),
  diagnoseHubPipelineVirtualRouterNative: jest.fn(() => ({ diagnostics: {} })),
  getHubPipelineVirtualRouterStatusNative: jest.fn(() => ({})),
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative: jest.fn(),
  disposeHubPipelineNative: jest.fn(),
  resolveBaseDir: jest.fn(() => process.cwd()),
}));

function installNativeHubPipelineRoute(server: any, routingPolicyGroup: string, route?: NativeRouteMock): void {
  activeNativeRouteMock = route;
  server.hubPipelinesByRoutingPolicyGroup = new Map([
    [routingPolicyGroup, 'mock_hub_pipeline_handle'],
  ]);
}

describe('direct server contract', () => {
  it('RED-GREEN: provider-direct forwards the original request body without stream/model repair', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const requestBody = {
      model: 'deepseek-v4-flash',
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    };
    let sentPayload: Record<string, unknown> | undefined;

    (server as any).resolveRuntimeKeyForProviderBinding = jest.fn(() => 'provider.key1.model');
    (server as any).resolveProviderHandleForBinding = jest.fn(() => ({
      runtimeKey: 'provider.key1.model',
      providerId: 'provider',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, data: { ok: true, echoedModel: payload.model, stream: payload.stream ?? null } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, data: { ok: true, echoedModel: payload.model, stream: payload.stream ?? null } };
        },
      },
    }));

    const result = await (server as any).executeProviderDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        protocolBehavior: 'auto',
        providerBinding: 'provider.key1.model',
      },
      {
        requestId: 'req_direct_provider_no_repair',
        entryEndpoint: '/v1/chat/completions',
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        query: {},
        body: requestBody,
        metadata: {
          stream: true,
          routeParams: { model: 'server-must-not-overwrite' },
          __raw_request_body: { model: 'raw-must-not-overwrite' },
        },
      },
    );

    expect(sentPayload).toBe(requestBody);
    expect(sentPayload?.model).toBe('deepseek-v4-flash');
    expect(sentPayload?.stream).toBeUndefined();
    expect(sentPayload?.stream_options).toEqual({ include_usage: true });
    expect((result.body as Record<string, unknown>).echoedModel).toBe('deepseek-v4-flash');
  });

  it('RED-GREEN: provider-direct forwards the live client abort signal into provider runtime metadata', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    const req = new EventEmitter() as any;
    req.headers = {};
    const res = new EventEmitter() as any;
    res.destroyed = false;
    res.writableEnded = false;
    res.writableFinished = false;
    const clientConnectionState = trackClientConnectionState(req, res);
    const expectedAbortSignal = getClientConnectionAbortSignal(clientConnectionState);

    const requestBody = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    };
    let sentPayload: Record<string, unknown> | undefined;

    (server as any).resolveRuntimeKeyForProviderBinding = jest.fn(() => 'provider.key1.model');
    (server as any).resolveProviderHandleForBinding = jest.fn(() => ({
      runtimeKey: 'provider.key1.model',
      providerId: 'provider',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, data: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, data: { ok: true } };
        },
      },
    }));

    await (server as any).executeProviderDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        protocolBehavior: 'auto',
        providerBinding: 'provider.key1.model',
      },
      {
        requestId: 'req_direct_provider_abort_signal',
        entryEndpoint: '/v1/chat/completions',
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        query: {},
        body: requestBody,
        metadata: {
          stream: true,
          clientConnectionState,
        },
      },
    );

    const runtimeMetadata = sentPayload ? extractProviderRuntimeMetadata(sentPayload) : undefined;
    const abortSignal = runtimeMetadata?.abortSignal as AbortSignal | undefined;
    expect(abortSignal).toBe(expectedAbortSignal);
    expect(abortSignal?.aborted).toBe(false);
  });

  it('RED-GREEN: router-direct forwards current tools, applies target model hook, and does not enter Hub execute', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const providerKey = 'DF.key1.deepseek-v4-pro';
    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 10000 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const route = jest.fn(() => ({
      target: {
        providerKey,
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey: providerKey,
        modelId: 'DeepSeek-V4-Pro',
      },
      decision: { routeName: 'thinking', pool: [providerKey], reason: 'thinking:user-input' },
      diagnostics: {},
    }));

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 10000,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_coding_10000',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_coding_10000', route);
    (server as any).providerHandles = new Map([
      [providerKey, {
        runtimeKey: providerKey,
        providerId: 'DF',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-chat',
        runtime: {},
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
            sentPayload = payload;
            return {
              status: 200,
              data: {
                id: 'chatcmpl_df_direct_passthrough',
                object: 'chat.completion',
                model: String(payload.model || ''),
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              },
            };
          }),
        },
      }],
    ]);

    const tools = [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }];
    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 10000,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_coding_10000',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_passthrough',
        entryEndpoint: '/v1/chat/completions',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'deepseek-v4-pro',
          stream: false,
          tools,
          messages: [{ role: 'user', content: 'hello' }],
        },
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(sentPayload?.model).toBe('DeepSeek-V4-Pro');
    expect(sentPayload?.tools).toBe(tools);
    expect((outcome.response as any)?.data?.model).toBe('DeepSeek-V4-Pro');
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('RED-GREEN: router-direct sends current raw responses body instead of prepared local continuation body', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const providerKey = 'openai.key1.gpt-5.5';
    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const rawInputItem = { role: 'user', content: [{ type: 'input_text', text: 'current raw request' }] };
    const preparedLocalContinuationItem = { content: [{ type: 'input_text', text: 'local continuation object without type' }] };

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5520,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_direct_5520',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    const route = jest.fn(() => ({
      target: {
        providerKey,
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: providerKey,
        modelId: 'gpt-5.5',
      },
      decision: { routeName: 'longcontext', pool: [providerKey], reason: 'longcontext:token-threshold' },
      diagnostics: {},
    }));

    installNativeHubPipelineRoute(server, 'gateway_direct_5520', route);
    (server as any).providerHandles = new Map([
      [providerKey, {
        runtimeKey: providerKey,
        providerId: 'openai',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: {},
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
            sentPayload = payload;
            return {
              status: 200,
              body: {
                id: 'resp_router_direct_raw_body',
                object: 'response',
                model: String(payload.model || ''),
                output: [],
              },
            };
          }),
        },
      }],
    ]);

    const rawBody = {
      model: 'gpt-5.4',
      stream: true,
      input: [rawInputItem],
    };
    const preparedBody = {
      model: 'gpt-5.4',
      stream: true,
      input: [preparedLocalContinuationItem],
    };

    const outcome = await (server as any).executePortAwarePipeline(5520, {
      requestId: 'req_router_direct_uses_raw_responses_body',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: rawBody,
      hubBody: preparedBody,
      metadata: {},
    });

    expect(outcome.status).toBe(200);
    expect(sentPayload).not.toBe(preparedBody);
    expect(sentPayload?.input).toEqual([rawInputItem]);
    expect(sentPayload?.input).not.toEqual([preparedLocalContinuationItem]);
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('RED-GREEN: router-direct relay sends prepared hub body to Hub instead of current raw body', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5520,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_direct_5520',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(),
      updateVirtualRouterConfig: jest.fn(),
    };
    installNativeHubPipelineRoute(server, 'gateway_direct_5520');
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'target_outbound_profile_requires_hub_relay',
      preselectedRoute: {
        target: {
          providerKey: 'anthropic.key1.claude-test',
          providerType: 'anthropic',
          outboundProfile: 'anthropic-messages',
          runtimeKey: 'anthropic.key1.claude-test',
        },
        decision: { routeName: 'default', pool: ['anthropic.key1.claude-test'] },
        diagnostics: {},
      },
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'resp_relay_uses_hub_body', object: 'response', output: [] },
    } as any);

    const rawBody = {
      model: 'gpt-5.4',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'current raw request' }] }],
    };
    const preparedHubBody = {
      model: 'gpt-5.4',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prepared hub request' }] }],
    };

    const metadata: Record<string, unknown> = {};
    const originalCenter = MetadataCenter.attach(metadata);
    writeMetadataCenterSlot({
      target: metadata,
      family: 'runtime_control',
      key: 'providerProtocol',
      value: 'openai-responses',
      writer: TEST_METADATA_WRITER,
      reason: 'seed entry provider protocol before router-direct relay',
    });

    await (server as any).executePortAwarePipeline(5520, {
      requestId: 'req_router_direct_relay_uses_hub_body',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: rawBody,
      hubBody: preparedHubBody,
      metadata,
    });

    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    const relayInput = executePipelineSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(relayInput.body).toBe(preparedHubBody);
    expect(relayInput.body).not.toBe(rawBody);
    expect(relayInput).not.toHaveProperty('hubBody');
    const relayMetadata = relayInput.metadata as Record<string, unknown>;
    expect(MetadataCenter.read(relayMetadata)).toBe(originalCenter);
    expect(originalCenter.readRuntimeControl().providerProtocol).toBe('anthropic-messages');
    expect(buildMetadataCenterRustSnapshot(relayMetadata).runtimeControl?.providerProtocol)
      .toBe('anthropic-messages');
  });

  it('RED-GREEN: router-direct retry releases single-use pins but preserves providerProtocol', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    writeMetadataCenterSlot({
      target: metadata,
      family: 'runtime_control',
      key: 'providerProtocol',
      value: 'openai-responses',
      writer: TEST_METADATA_WRITER,
      reason: 'seed provider protocol before router-direct retry',
    });
    writeMetadataCenterSlot({
      target: metadata,
      family: 'runtime_control',
      key: 'preselectedRoute',
      value: { target: { providerKey: 'orangeai.key1.glm-5.2' } },
      writer: TEST_METADATA_WRITER,
      reason: 'seed stale preselected route before router-direct retry',
    });
    writeMetadataCenterSlot({
      target: metadata,
      family: 'runtime_control',
      key: 'retryProviderKey',
      value: 'orangeai.key1.glm-5.2',
      writer: TEST_METADATA_WRITER,
      reason: 'seed stale retry provider pin before router-direct retry',
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5520,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_direct_5520',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    const route = jest.fn(() => ({
      decision: { routeName: 'longcontext', pool: [] },
      diagnostics: {},
    }));

    installNativeHubPipelineRoute(server, 'gateway_direct_5520', route);

    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_direct_5520',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_retry_preserves_provider_protocol',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'gpt-5.4',
          stream: true,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'retry' }] }],
        },
        metadata,
      },
      {
        maxAttempts: 6,
        excludedProviderKeys: new Set(['orangeai.key1.glm-5.2']),
      },
      2,
    );

    expect(outcome.used).toBe(false);
    expect(MetadataCenter.read(metadata)).toBe(center);
    expect(center.readRuntimeControl().providerProtocol).toBe('openai-responses');
    expect(center.readRuntimeControl().preselectedRoute).toBeUndefined();
    expect(center.readRuntimeControl().retryProviderKey).toBeUndefined();
    expect(buildMetadataCenterRustSnapshot(metadata).runtimeControl?.providerProtocol)
      .toBe('openai-responses');
    expect(buildMetadataCenterRustSnapshot(metadata).runtimeControl?.preselectedRoute)
      .toBeUndefined();
    expect(buildMetadataCenterRustSnapshot(metadata).runtimeControl?.retryProviderKey)
      .toBeUndefined();
  });
});
