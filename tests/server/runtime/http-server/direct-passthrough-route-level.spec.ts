import { describe, expect, it, jest } from '@jest/globals';
import { readRuntimeControlProjection } from '../../../../src/server/runtime/http-server/metadata-center/request-truth-readers.js';

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
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(() => ({ runtimeControl: {} })),
  resolveEntryProtocolFromEndpointNative: jest.fn((endpoint: string) => {
    if (endpoint === '/v1/responses' || endpoint.endsWith('/responses')) return 'openai-responses';
    if (endpoint === '/v1/messages' || endpoint.endsWith('/messages')) return 'anthropic';
    return 'openai-chat';
  }),
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
}));

jest.unstable_mockModule('../../../../src/server/runtime/http-server/hub-pipeline-handle.js', () => ({
  readHubPipelineNativeHandle: (pipeline: unknown) => {
    if (typeof pipeline === 'string' && pipeline.trim()) {
      return pipeline;
    }
    return null;
  },
}));

function installNativeHubPipelineRoute(server: any, routingPolicyGroup: string, route?: NativeRouteMock): void {
  activeNativeRouteMock = route;
  executeHubPipelineNativeMock.mockClear();
  server.hubPipeline = 'mock_hub_pipeline_handle';
  server.hubPipelinesByRoutingPolicyGroup = new Map([
    [routingPolicyGroup, 'mock_hub_pipeline_handle'],
  ]);
  server.pipelineRuntimeConfigByRoutingPolicyGroup = new Map([
    [routingPolicyGroup, { routingProviderIds: readProviderIdsForRoutingPolicyGroup(server, routingPolicyGroup) }],
  ]);
}

function readProviderIdsForRoutingPolicyGroup(server: any, routingPolicyGroup: string): string[] {
  const group = server.userConfig?.virtualrouter?.routingPolicyGroups?.[routingPolicyGroup];
  const routing = group && typeof group === 'object' && !Array.isArray(group)
    ? (group as Record<string, unknown>).routing
    : undefined;
  const ids = new Set<string>();
  if (routing && typeof routing === 'object' && !Array.isArray(routing)) {
    for (const tiers of Object.values(routing as Record<string, unknown>)) {
      if (!Array.isArray(tiers)) {
        continue;
      }
      for (const tier of tiers) {
        if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
          continue;
        }
        const targets = (tier as Record<string, unknown>).targets;
        if (!Array.isArray(targets)) {
          continue;
        }
        for (const target of targets) {
          if (typeof target !== 'string') {
            continue;
          }
          const providerId = target.split('.').map((part) => part.trim()).find(Boolean);
          if (providerId) {
            ids.add(providerId);
          }
        }
      }
    }
  }
  return [...ids].sort();
}

describe('direct passthrough route-level', () => {
  it('HTTP BLACKBOX: provider-mode keyless chat binding preserves client model', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const runtimeKey = 'opencode-zen-free.key1.deepseek-v4-flash-free';
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'opencode-zen-free',
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
          if (payload.model !== 'deepseek-v4-flash') {
            return {
              status: 401,
              data: {
                error: {
                  type: 'ModelError',
                  message: `Model ${String(payload.model)} is not supported`,
                },
              },
            };
          }
          return {
            status: 200,
            data: {
              id: 'chatcmpl_provider_direct_keyless_model_blackbox',
              object: 'chat.completion',
              model: payload.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          };
        }),
      },
    }]]);
    (server as any).providerKeyToRuntimeKey = new Map([
      ['opencode-zen-free.deepseek-v4-flash-free', runtimeKey],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'provider',
      protocolBehavior: 'auto',
      providerBinding: 'opencode-zen-free.deepseek-v4-flash-free',
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'chatcmpl_provider_direct_keyless_model_blackbox',
        model: 'deepseek-v4-flash',
      }));
      expect(sentPayload?.model).toBe('deepseek-v4-flash');
    } finally {
      await server.stop();
    }
  });

  it('HTTP BLACKBOX: provider-mode chat direct does not synthesize stream=true when stream_options is present', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const runtimeKey = 'opencode-zen-free.key1.deepseek-v4-flash-free';
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'opencode-zen-free',
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
          if (payload.stream_options && payload.stream !== true) {
            return {
              status: 400,
              data: {
                error: {
                  message: 'stream_options should be set along with stream = true',
                  type: 'invalid_request_error',
                },
              },
            };
          }
          return {
            status: 200,
            data: {
              id: 'chatcmpl_provider_direct_stream_options_blackbox',
              object: 'chat.completion',
              model: payload.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          };
        }),
      },
    }]]);
    (server as any).providerKeyToRuntimeKey = new Map([
      ['opencode-zen-free.deepseek-v4-flash-free', runtimeKey],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'provider',
      protocolBehavior: 'auto',
      providerBinding: 'opencode-zen-free.deepseek-v4-flash-free',
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const bodyText = await response.text();

      expect(response.status).toBe(200);
      expect(bodyText).toContain('stream_options should be set along with stream = true');
      expect(sentPayload?.model).toBe('deepseek-v4-flash');
      expect(sentPayload?.stream).toBeUndefined();
      expect(sentPayload?.stream_options).toEqual({ include_usage: true });
    } finally {
      await server.stop();
    }
  }, 15000);

  it('provider-mode direct sends current request body and ignores metadata.__raw_request_body', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const { extractProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    (server as any).resolveRuntimeKeyForProviderBinding = jest.fn(() => 'dbittai-gpt.key1.gpt-5.3-codex');
    (server as any).resolveProviderHandleForBinding = jest.fn(() => ({
      runtimeKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerId: 'dbittai-gpt',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    }));

    await (server as any).executeProviderDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        protocolBehavior: 'auto',
        providerBinding: 'dbittai-gpt.key1.gpt-5.3-codex',
      },
      {
        requestId: 'req_provider_route_level_raw',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'mutated-model',
          instructions: 'mutated-system-prompt',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
        },
        metadata: {
          __raw_request_body: {
            model: 'raw-model',
            previous_response_id: 'resp_prev_raw',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          },
        },
      },
    );

    expect(sentPayload).toEqual({
      model: 'mutated-model',
      instructions: 'mutated-system-prompt',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
    });
    expect((sentPayload as Record<string, unknown>).previous_response_id).toBeUndefined();
    expect(extractProviderRuntimeMetadata(sentPayload as Record<string, unknown>)?.metadata?.__responsesDirectPassthrough).toBe(true);
  }, 15000);

  it('router same-protocol direct does not enter HubPipeline and only normalizes provider model', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const { extractProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const providerHandle = {
      runtimeKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerId: 'dbittai-gpt',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    };

    const routerRoute = jest.fn(() => ({
      target: {
        providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: providerHandle.runtimeKey,
        modelId: 'gpt-5.3-codex',
      },
      decision: { routeName: 'default', pool: ['dbittai-gpt.key1.gpt-5.3-codex'] },
      diagnostics: {},
    }));
    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    installNativeHubPipelineRoute(server, 'default', routerRoute);

    const directResult = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '0.0.0.0',
        mode: 'router',
        routingPolicyGroup: 'default',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_route_level_raw',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'mutated-model',
          instructions: 'mutated-system-prompt',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
        },
        metadata: {
          __raw_request_body: {
            model: 'raw-model',
            previous_response_id: 'resp_prev_router',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          },
        },
      },
    );

    expect(directResult.used).toBe(true);
    expect(sentPayload).toEqual({
      model: 'gpt-5.3-codex',
      instructions: 'mutated-system-prompt',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
    });
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
    expect(routerRoute).toHaveBeenCalledTimes(1);
    expect((sentPayload as Record<string, unknown>).previous_response_id).toBeUndefined();
    expect(extractProviderRuntimeMetadata(sentPayload as Record<string, unknown>)?.metadata?.__responsesDirectPassthrough).toBe(true);
  });

  it('router same-protocol direct stays direct for responses target with chat process mode', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const providerHandle = {
      runtimeKey: 'cc.key1',
      providerId: 'cc',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { id: 'resp_same_protocol_process_chat_direct', direct: true } };
        }),
      },
    };

    const routerRoute = jest.fn(() => ({
      target: {
        providerKey: 'cc.key1.gpt-5.5',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        processMode: 'chat',
        runtimeKey: providerHandle.runtimeKey,
        modelId: 'gpt-5.5',
      },
      decision: { routeName: 'default', pool: ['cc.key1.gpt-5.5'] },
      diagnostics: {},
    }));
    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', routerRoute);

    const directResult = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '0.0.0.0',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5520',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_same_protocol_process_chat_direct',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        },
        metadata: {},
      },
    );

    expect(directResult.used).toBe(true);
    expect(directResult.auditContext.providerKey).toBe('cc.key1.gpt-5.5');
    expect(sentPayload).toEqual({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
    expect(providerHandle.instance.processIncomingDirect).toHaveBeenCalledTimes(1);
    expect(providerHandle.instance.processIncoming).not.toHaveBeenCalled();
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('router same-protocol direct sends route-safe metadata for cyclic image requests before VR', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    let routeMetadata: Record<string, unknown> | undefined;
    const providerHandle = {
      runtimeKey: 'cc.key1.gpt-5.5',
      providerId: 'cc',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtime: { modelId: 'gpt-5.5', modelCapabilities: { 'gpt-5.5': ['text', 'multimodal'] } },
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    };

    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      routeMetadata = metadata;
      expect(() => JSON.stringify(metadata)).not.toThrow();
      return {
        target: {
          providerKey: 'cc.key1.gpt-5.5',
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerHandle.runtimeKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'longcontext', pool: ['cc.key1.gpt-5.5'] },
        diagnostics: {},
      };
    });

    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);

    const requestBody = {
      model: 'gpt-5.5',
      stream: true,
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe this image' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      }],
    };
    const metadata: Record<string, unknown> = {
      requestId: 'req_router_direct_cyclic_image',
      clientRequestId: 'client-router-direct-cyclic-image',
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      __raw_request_body: requestBody,
      entryOriginRequest: requestBody,
      requestSemantics: { input: requestBody.input },
      metadataCenterSnapshot: {
        requestTruth: { requestId: 'req_router_direct_cyclic_image', sessionId: 'sess-image' },
        runtimeControl: { routecodexRoutingPolicyGroup: 'gateway_priority_5520' },
      },
    };
    metadata.self = metadata;

    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '0.0.0.0',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5520',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_cyclic_image',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: requestBody,
        metadata,
      },
    );

    expect(outcome.used).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
    expect(routeMetadata).toEqual(expect.objectContaining({
      requestId: 'req_router_direct_cyclic_image',
      clientRequestId: 'client-router-direct-cyclic-image',
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      metadataCenterSnapshot: expect.objectContaining({
        requestId: 'req_router_direct_cyclic_image',
        runtimeControl: expect.objectContaining({ routecodexRoutingPolicyGroup: 'gateway_priority_5520' }),
      }),
    }));
    expect(routeMetadata).not.toHaveProperty('__raw_request_body');
    expect(routeMetadata).not.toHaveProperty('entryOriginRequest');
    expect(routeMetadata).not.toHaveProperty('requestSemantics');
    expect(routeMetadata).not.toHaveProperty('self');
    expect(JSON.stringify(routeMetadata)).not.toContain('data:image/png;base64,AAAA');
    expect(sentPayload?.input).toBe(requestBody.input);
    expect(JSON.stringify(sentPayload)).toContain('data:image/png;base64,AAAA');
  });

  it('router same-protocol direct supplies request-scoped log color key when no client session exists', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    let routeMetadata: Record<string, unknown> | undefined;
    const providerHandle = {
      runtimeKey: 'orangeai.key1.glm-5.2',
      providerId: 'orangeai',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    };
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      routeMetadata = metadata;
      return {
        target: {
          providerKey: 'orangeai.key1.glm-5.2',
          providerType: 'responses',
          outboundProfile: 'openai-responses',
          runtimeKey: providerHandle.runtimeKey,
          modelId: 'glm-5.2',
        },
        decision: { routeName: 'longcontext', pool: ['orangeai.key1.glm-5.2'] },
        diagnostics: {},
      };
    });
    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', route);

    const directBody = {
      model: 'gpt-5.5',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };

    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_no_session_color',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: directBody,
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(sentPayload).toEqual({
      model: 'glm-5.2',
      stream: true,
      input: directBody.input,
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(routeMetadata).toEqual(expect.objectContaining({
      requestId: 'req_router_direct_no_session_color',
      logSessionColorKey: 'rcc-session:request:req_router_direct_no_session_color',
      metadataCenterSnapshot: expect.objectContaining({
        logSessionColorKey: 'rcc-session:request:req_router_direct_no_session_color',
      }),
    }));
    expect(routeMetadata).not.toHaveProperty('sessionId');
    expect(routeMetadata).not.toHaveProperty('conversationId');
  });

  it('router same-protocol direct does not preflight Responses tool-output wire shape', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const providerHandle = {
      runtimeKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerId: 'dbittai-gpt',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    };

    const routerRoute = jest.fn(() => ({
      target: {
        providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: providerHandle.runtimeKey,
        modelId: 'gpt-5.3-codex',
      },
      decision: { routeName: 'default', pool: ['dbittai-gpt.key1.gpt-5.3-codex'] },
      diagnostics: {},
    }));
    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    installNativeHubPipelineRoute(server, 'default', routerRoute);

    const directBody = {
      model: 'gpt-5.3-codex',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'ok',
          content: [{ type: 'output_text', text: 'historical provider-owned shape' }],
        },
      ],
    };

    const directResult = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '0.0.0.0',
        mode: 'router',
        routingPolicyGroup: 'default',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_no_responses_wire_preflight',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: directBody,
        metadata: {},
      },
    );

    expect(directResult.used).toBe(true);
    expect(sentPayload).toEqual(directBody);
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
    expect(routerRoute).toHaveBeenCalledTimes(1);
  });

  it('router direct keeps runtime carrier after model override clones payload', async () => {
    jest.resetModules();
    const { executeRouterDirectPipeline } = await import('../../../../src/server/runtime/http-server/router-direct-pipeline.js');
    const {
      attachProviderRuntimeMetadata,
      extractProviderRuntimeMetadata
    } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');
    const { MetadataCenter } = await import('../../../../src/server/runtime/http-server/metadata-center/metadata-center.js');

    let sentPayload: Record<string, unknown> | undefined;
    const metadataCarrier = {
      entryEndpoint: '/v1/responses',
      __responsesDirectPassthrough: true
    } as Record<string, unknown>;
    MetadataCenter.attach(metadataCarrier).writeRequestTruth(
      'portScope',
      '5520',
      {
        module: 'tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts',
        symbol: 'router direct keeps runtime carrier after model override clones payload',
        stage: 'ServerReqInbound01ClientRaw'
      }
    );
    const requestPayload = {
      model: 'client-alias',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
    } as Record<string, unknown>;
    attachProviderRuntimeMetadata(requestPayload, {
      requestId: 'req_router_direct_runtime_clone',
      providerId: 'cc',
      providerKey: 'cc.key1.gpt-5.5',
      providerProtocol: 'openai-responses',
      metadata: metadataCarrier
    });

    const outcome = await executeRouterDirectPipeline({
      portConfig: {
        port: 5520,
        host: '0.0.0.0',
        mode: 'router',
        sameProtocolBehavior: 'direct'
      },
      providerPayload: requestPayload,
      requestPayload,
      requestId: 'req_router_direct_runtime_clone',
      target: {
        providerKey: 'cc.key1.gpt-5.5',
        providerType: 'responses',
        runtimeKey: 'cc.key1.gpt-5.5',
        modelId: 'gpt-5.5'
      },
      requestInfo: {
        path: '/v1/responses',
        headers: {}
      },
      resolveProviderByRuntimeKey: () => ({
        runtimeKey: 'cc.key1.gpt-5.5',
        providerId: 'cc',
        providerType: 'responses',
        providerFamily: 'responses',
        providerProtocol: 'openai-responses',
        runtime: {},
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
            sentPayload = payload;
            return { status: 200, body: { ok: true } };
          })
        }
      } as any)
    });

    expect(outcome.used).toBe(true);
    expect(sentPayload).toMatchObject({ model: 'gpt-5.5' });
    const runtimeMetadata = extractProviderRuntimeMetadata(sentPayload as Record<string, unknown>);
    expect(runtimeMetadata?.requestId).toBe('req_router_direct_runtime_clone');
    expect(runtimeMetadata?.providerKey).toBe('cc.key1.gpt-5.5');
    expect(runtimeMetadata?.metadata?.__responsesDirectPassthrough).toBe(true);
    expect(MetadataCenter.read(runtimeMetadata?.metadata)?.readRequestTruth().portScope).toBe('5520');
  });

  it('router same-protocol direct keeps client tools on direct path', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const directSend = jest.fn(async () => ({
      status: 200,
      body: { object: 'response', id: 'resp_direct_chat_style_tool' },
    }));
    const providerHandle = {
      runtimeKey: 'asxs.crsa.gpt-5.5',
      providerId: 'asxs',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: directSend,
        processIncomingDirect: directSend,
      },
    };
    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey: 'asxs.crsa.gpt-5.5',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: providerHandle.runtimeKey,
        modelId: 'gpt-5.5',
      },
      decision: { routeName: 'thinking', pool: ['asxs.crsa.gpt-5.5'] },
      diagnostics: {},
    })));

    for (const nestedToolIndex of [0, 3, 11]) {
      directSend.mockClear();
      const tools = Array.from({ length: 12 }, (_, index) => (
        index === nestedToolIndex
          ? { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
          : { type: 'function', name: `tool_${index}`, description: `tool ${index}`, parameters: { type: 'object' } }
      ));

      const outcome = await (server as any).executeRouterDirectPipelineForPort(
        {
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        },
        {
          requestId: `req_router_direct_nested_tool_${nestedToolIndex}`,
          entryEndpoint: '/v1/responses',
          method: 'POST',
          headers: {},
          query: {},
          body: {
            model: 'gpt-5.5',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'sample lock' }] }],
            tools,
          },
          metadata: {},
        },
      );

      expect(outcome.used).toBe(true);
      expect(outcome.reason).toBeUndefined();
      expect(directSend).toHaveBeenCalledTimes(1);
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
    }
  });

  it('router same-protocol direct relays stop_message followup through Hub before direct send', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const { MetadataCenter } = await import('../../../../src/server/runtime/http-server/metadata-center/metadata-center.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const routerDirectSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort');
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { object: 'response', id: 'resp_stop_followup_relay' },
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey: 'cc.key1.gpt-5.5',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'cc.key1.gpt-5.5',
        modelId: 'gpt-5.5',
      },
      decision: { routeName: 'thinking', pool: ['cc.key1.gpt-5.5'], reason: 'thinking:test' },
      diagnostics: {},
    })));

  });

  it('router same-protocol direct passes x-route-hint into direct preroute metadata', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    server.seedUserConfigForBootstrap({
      httpserver: {
        ports: [
          {
            port: 5555,
            host: '127.0.0.1',
            mode: 'router',
            routingPolicyGroup: 'gateway_priority_5555',
            sameProtocolBehavior: 'direct',
          },
        ],
      },
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey: 'cc.key1.gpt-5.5',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'cc.key1.gpt-5.5',
        modelId: 'gpt-5.5',
      },
      decision: { routeName: 'thinking', pool: ['cc.key1.gpt-5.5'], reason: 'thinking:test' },
      diagnostics: {},
    })));

    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: true,
      response: { status: 200, body: { ok: true } },
      providerHandle: {} as any,
      auditContext: {} as any,
    } as any);

    await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_direct_route_hint_search',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: { 'x-route-hint': 'search' },
      query: {},
      body: {
        model: 'gpt-5.5',
        instructions: 'hello',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      metadata: {},
    });

    expect(directSpy).toHaveBeenCalledTimes(1);
    const directMetadata = directSpy.mock.calls[0]?.[1]?.metadata as Record<string, unknown>;
    expect(readRuntimeControlProjection(directMetadata).routeHint).toBe('search');
    expect(directMetadata).toEqual(expect.objectContaining({
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      __rt: expect.objectContaining({
        sessionDir: expect.stringContaining('ports/gateway_priority_5555'),
      }),
    }));
  });

  it('router same-protocol direct rejects relay-owned responses scope materialize instead of entering relay', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const routerDirectSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'relay_owned_responses_continuation',
      preselectedRoute: {
        target: {
          providerKey: 'orangeai.key1.glm-5.2',
          runtimeKey: 'orangeai.key1.glm-5.2',
          outboundProfile: 'openai-responses',
        },
        decision: { route: 'longcontext' },
        diagnostics: { reason: 'longcontext:token-threshold' },
      },
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { object: 'response', id: 'resp_relay_scope_materialize' },
      metadata: { relayed: true },
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey: 'orangeai.key1.glm-5.2',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'orangeai.key1.glm-5.2',
        modelId: 'glm-5.2',
      },
      decision: { routeName: 'longcontext', pool: ['orangeai.key1.glm-5.2'], reason: 'longcontext:test' },
      diagnostics: {},
    })));

    await expect((server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_direct_must_skip_relay_owned_scope_materialize',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'gpt-5.4',
        input: [
          { type: 'function_call_output', call_id: 'call_1', output: 'pong' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
        ],
      },
      metadata: {
        responsesResume: {
          continuationOwner: 'relay',
          materialized: true,
          restored: true,
          scopeKey: 'entry:responses|owner:relay|session:test',
        },
      },
    })).rejects.toThrow('router-direct failed without relay: relay_owned_responses_continuation');

    expect(routerDirectSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).not.toHaveBeenCalled();
  });

  it('router same-protocol client tools request stays on direct path', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const routerDirectSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: true,
      response: { status: 200, body: { ok: true, mode: 'direct' } },
      providerHandle: {} as any,
      auditContext: {} as any,
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { object: 'response', id: 'resp_relay_tools_stopmessage' },
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5520,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', jest.fn(() => ({
      target: {
        providerKey: 'cc.key1.gpt-5.5',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'cc.key1.gpt-5.5',
        modelId: 'gpt-5.5',
      },
      decision: { routeName: 'thinking', pool: ['cc.key1.gpt-5.5'], reason: 'thinking:test' },
      diagnostics: {},
    })));

    const result = await (server as any).executePortAwarePipeline(5520, {
      requestId: 'openai-responses-router-gpt-5.5-tools-stopmessage',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      },
      metadata: {},
    });

    expect(routerDirectSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(result?.body).toMatchObject({ ok: true, mode: 'direct' });
  });

  it('router port metadata exposes only its routing policy group providers', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'relay',
        }],
      },
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5555: { routing: { default: [{ id: 'route-5555', targets: ['mimo.key1.model-a'] }] } },
          gateway_coding_10000: { routing: { default: [{ id: 'route-10000', targets: ['llmgate.key2.model-b'] }] } },
        },
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey: 'mimo.key1.model-a',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'mimo.key1.model-a',
        modelId: 'model-a',
      },
      decision: { routeName: 'default', pool: ['mimo.key1.model-a'], reason: 'default:test' },
      diagnostics: {},
    })));
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({ status: 200, body: { ok: true } } as any);

    await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_port_scope_metadata',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: { model: 'gpt-5.5', input: 'hello' },
      metadata: {},
    });

    expect(executePipelineSpy.mock.calls[0]?.[0]?.metadata).toEqual(expect.objectContaining({
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      allowedProviders: ['mimo'],
      __rt: expect.objectContaining({
        sessionDir: expect.stringContaining('ports/gateway_priority_5555'),
      }),
    }));
  });

  it('HTTP BLACKBOX: router-direct emits direct send log for direct success', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const logs: string[] = [];
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const captureLog = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };
    console.log = (...args: unknown[]) => { captureLog(...args); originalLog(...args); };
    console.info = (...args: unknown[]) => { captureLog(...args); originalInfo(...args); };
    console.warn = (...args: unknown[]) => { captureLog(...args); originalWarn(...args); };
    process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
      logs.push(String(chunk));
      return originalStdoutWrite(chunk as string | Uint8Array, ...(args as []));
    }) as typeof process.stdout.write;

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerKey = 'direct.key1.gpt-test';
    const runtimeKey = 'runtime:direct';
    const directSend = jest.fn(async () => ({
      status: 200,
      data: { id: 'resp_direct_log_blackbox', object: 'response', output_text: 'ok_direct' },
    }));

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey,
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey,
        modelId: 'gpt-test',
      },
      decision: {
        routeName: 'thinking',
        pool: [providerKey],
        poolId: 'gateway-priority-5555-thinking',
        reasoning: 'thinking:user-input',
      },
      diagnostics: {},
    })));
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'direct',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtime: { modelId: 'gpt-test' },
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: directSend,
      },
    }]]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.4',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'read only question' }] }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: 'resp_direct_log_blackbox' }));
      expect(directSend).toHaveBeenCalledTimes(1);
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
      await server.stop();
    }
  }, 15000);

  it('router same-protocol direct remains direct when stopless metadata is present', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey: 'direct.key1.gpt-test',
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey: 'direct.key1.gpt-test',
        modelId: 'gpt-test',
      },
      decision: { routeName: 'search', pool: ['direct.key1.gpt-test'] },
      diagnostics: {},
    })));
    (server as any).providerHandles = new Map([[
      'direct.key1.gpt-test',
      {
        providerProtocol: 'openai-chat',
        instance: {
          processIncomingDirect: jest.fn(async () => ({
            status: 200,
            data: {
              id: 'chatcmpl_direct_stopless_metadata_passthrough',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          })),
        },
      },
    ]]);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort');

    const result = await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_direct_stopless_stays_direct',
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
      metadata: {
        stoplessMode: 'on',
        stoplessArmed: true,
      },
    });

    expect(result.body?.id).toBe('chatcmpl_direct_stopless_metadata_passthrough');
    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).not.toHaveBeenCalled();
  });

  it('router same-protocol direct with stop finish_reason does not project stopless cli/tool call', async () => {
    jest.resetModules();
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
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', jest.fn(() => ({
      target: {
        providerKey: 'direct.key1.gpt-test',
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey: 'direct.key1.gpt-test',
        modelId: 'gpt-test',
      },
      decision: { routeName: 'coding', pool: ['direct.key1.gpt-test'] },
      diagnostics: {},
    })));
    (server as any).providerHandles = new Map([[
      'direct.key1.gpt-test',
      {
        providerProtocol: 'openai-chat',
        instance: {
          processIncomingDirect: jest.fn(async () => ({
            status: 200,
            data: {
              id: 'chatcmpl_direct_stop_finish_passthrough',
              object: 'chat.completion',
              choices: [{
                index: 0,
                message: { role: 'assistant', content: 'direct stop reply' },
                finish_reason: 'stop'
              }],
            },
          })),
        },
      },
    ]]);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort');

    const result = await (server as any).executePortAwarePipeline(5520, {
      requestId: 'req_router_direct_stop_finish_passthrough',
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
      metadata: {
        stoplessMode: 'on',
        stoplessArmed: true,
        sessionId: 'direct-stopless-must-not-activate',
      },
    });

    expect(result.body?.id).toBe('chatcmpl_direct_stop_finish_passthrough');
    expect(result.body?.choices?.[0]?.message?.content).toBe('direct stop reply');
    expect(JSON.stringify(result.body)).not.toContain('routecodex servertool run stop_message_auto');
    expect(JSON.stringify(result.body)).not.toContain('tool_calls');
    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).not.toHaveBeenCalled();
  });

  it('HTTP BLACKBOX: router-direct passes provider response body through without model rewrite', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerKey = 'cc.key1.gpt-5.5';
    const runtimeKey = 'runtime:cc';
    const directSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_passthrough_model',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.5',
        output_text: 'ok'
      },
    }));

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', jest.fn(() => ({
      target: {
        providerKey,
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey,
        modelId: 'gpt-5.5',
      },
      decision: { routeName: 'coding', pool: [providerKey], reason: 'coding:user-input' },
      diagnostics: {},
    })));
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'cc',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtime: { modelId: 'gpt-5.5' },
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: directSend,
      },
    }]]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'read only question' }] }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_router_direct_passthrough_model',
        model: 'gpt-5.5',
      }));
      expect(JSON.stringify(body)).not.toContain('missing choices');
      expect(directSend).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('router-direct switches provider request-locally on recoverable 429 without entering relay', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.5';
    const secondProviderKey = 'llmgate.key1.gpt-5.5';
    const sentPayloads: Record<string, unknown>[] = [];
    const direct429 = () => Object.assign(new Error('HTTP 429: Concurrency limit exceeded for user'), {
      statusCode: 429,
      status: 429,
      code: 'HTTP_429',
      upstreamCode: 'HTTP_429',
    });
    const firstDirectSend = jest.fn(async (payload: Record<string, unknown>) => {
      sentPayloads.push(payload);
      throw direct429();
    });
    const secondDirectSend = jest.fn(async (payload: Record<string, unknown>) => {
      sentPayloads.push(payload);
      return {
        status: 200,
        data: {
          id: 'resp_router_direct_429_switched',
          object: 'response',
          status: 'completed',
          output_text: 'ok',
        },
      };
    });
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const snapshot = metadata.metadataCenterSnapshot && typeof metadata.metadataCenterSnapshot === 'object'
        ? metadata.metadataCenterSnapshot as Record<string, unknown>
        : {};
      const excluded = Array.isArray(snapshot.excludedProviderKeys) ? snapshot.excludedProviderKeys : [];
      const providerKey = excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey;
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'thinking', pool: [firstProviderKey, secondProviderKey], reason: 'thinking:test' },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'llmgate',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    const requestBody = {
      model: 'router-gpt-5.5',
      stream: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };
    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_429_switch',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: requestBody,
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(outcome.auditContext.providerKey).toBe(secondProviderKey);
    expect(outcome.response?.data).toMatchObject({ id: 'resp_router_direct_429_switched' });
    expect(firstDirectSend).toHaveBeenCalledTimes(1);
    expect(secondDirectSend).toHaveBeenCalledTimes(1);
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads.map((payload) => payload.model)).toEqual(['gpt-5.5', 'gpt-5.5']);
    expect(sentPayloads.map((payload) => payload.input)).toEqual([requestBody.input, requestBody.input]);
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[0]?.[1]).toEqual(expect.not.objectContaining({ excludedProviderKeys: expect.anything() }));
    expect(route.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      excludedProviderKeys: [firstProviderKey],
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
    }));
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('router-direct excludes failed provider first; cross-protocol VR target then uses relay boundary', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'ykk.ykk.gpt-5.3-codex-spark';
    const secondProviderKey = 'minimax.key1.MiniMax-M3';
    const direct429 = () => Object.assign(new Error('HTTP 429: Concurrency limit exceeded for user'), {
      statusCode: 429,
      status: 429,
      code: 'HTTP_429',
      upstreamCode: 'HTTP_429',
    });
    const firstDirectSend = jest.fn(async () => {
      throw direct429();
    });
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'should_not_direct_send_cross_protocol_target',
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const snapshot = metadata.metadataCenterSnapshot && typeof metadata.metadataCenterSnapshot === 'object'
        ? metadata.metadataCenterSnapshot as Record<string, unknown>
        : {};
      const excluded = Array.isArray(snapshot.excludedProviderKeys) ? snapshot.excludedProviderKeys : [];
      const useRelayTarget = excluded.includes(firstProviderKey);
      const providerKey = useRelayTarget ? secondProviderKey : firstProviderKey;
      return {
        target: {
          providerKey,
          providerType: useRelayTarget ? 'anthropic' : 'openai',
          outboundProfile: useRelayTarget ? 'anthropic-messages' : 'openai-responses',
          runtimeKey: providerKey,
          modelId: useRelayTarget ? 'MiniMax-M3' : 'gpt-5.3-codex-spark',
        },
        decision: { routeName: 'tools', pool: [firstProviderKey, secondProviderKey], reason: 'tools:test' },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_glm_4444',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_glm_4444', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'ykk',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.3-codex-spark' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'minimax',
        providerType: 'anthropic',
        providerFamily: 'anthropic',
        providerProtocol: 'anthropic-messages',
        runtime: { modelId: 'MiniMax-M3' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    const requestBody = {
      model: 'router-gpt-5.5',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };
    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_glm_4444',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_429_cross_protocol_relay',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: requestBody,
        metadata: {},
      },
    );

    expect(outcome.used).toBe(false);
    expect(outcome.reason).toBe('target_outbound_profile_requires_hub_relay');
    expect(outcome.preselectedRoute?.target).toMatchObject({
      providerKey: secondProviderKey,
      outboundProfile: 'anthropic-messages',
    });
    // 429 only mutates the VR exclusion set. Relay is selected later because
    // the new VR target protocol differs from the entry protocol.
    expect(firstDirectSend).toHaveBeenCalledTimes(1);
    expect(secondDirectSend).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      excludedProviderKeys: [firstProviderKey],
      metadataCenterSnapshot: expect.objectContaining({
        excludedProviderKeys: [firstProviderKey],
      }),
      routecodexRoutingPolicyGroup: 'gateway_glm_4444',
    }));
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('router-direct switches to alternative provider immediately for recoverable 502 when VR has another target', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'sdfv.key1.gpt-5.5';
    const secondProviderKey = 'llmgate.key1.gpt-5.5';
    const direct502 = () => Object.assign(new Error('HTTP 502: upstream stream incomplete'), {
      statusCode: 502,
      status: 502,
      code: 'HTTP_502',
      upstreamCode: 'HTTP_502',
    });
    const firstDirectSend = jest.fn(async () => { throw direct502(); });
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_502_switched_immediately',
        object: 'response',
        status: 'completed',
        output_text: 'ok',
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'longcontext', pool: [firstProviderKey, secondProviderKey], reason: 'longcontext:test' },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'sdfv',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'llmgate',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_502_switch_immediately',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'router-gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        },
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(outcome.auditContext.providerKey).toBe(secondProviderKey);
    expect(outcome.response?.data).toMatchObject({ id: 'resp_router_direct_502_switched_immediately' });
    expect(firstDirectSend).toHaveBeenCalledTimes(1);
    expect(secondDirectSend).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[0]?.[1]).toEqual(expect.not.objectContaining({ __routecodexRetryProviderKey: expect.anything() }));
    expect(route.mock.calls[1]?.[1]).toEqual(expect.not.objectContaining({ __routecodexRetryProviderKey: expect.anything() }));
    expect(route.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      excludedProviderKeys: [firstProviderKey],
    }));
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('router same-protocol direct uses target.modelId as outbound model instead of inbound alias', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 10000 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const providerKey = 'DF.key1.deepseek-v4-pro';
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
    (server as any).currentRouterArtifacts = {
      targetRuntime: {
        [providerKey]: {
          runtimeKey: providerKey,
          providerId: 'DF',
          providerType: 'openai',
          providerKey,
          defaultModel: 'DeepSeek-V4-Pro',
          endpoint: 'https://www.dreamfield.top/v1',
          auth: { type: 'apikey', value: 'test' },
        },
      },
    };
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
                id: 'chatcmpl_df_alias_canonical',
                object: 'chat.completion',
                model: String(payload.model || ''),
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              },
            };
          }),
        },
      }],
    ]);

    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 10000,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_coding_10000',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_df_alias_canonical',
        entryEndpoint: '/v1/chat/completions',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'deepseek-v4-pro',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        },
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(sentPayload?.model).toBe('deepseek-v4-pro');
    expect((outcome.response as any)?.data?.model).toBe('deepseek-v4-pro');
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('router-direct reroutes by decision.routePool when decision.pool is narrowed to current provider', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.4';
    const secondProviderKey = '1token.key1.gpt-5.4';
    const direct502 = () => Object.assign(new Error('HTTP 502: upstream provider error'), {
      statusCode: 502,
      status: 502,
      code: 'HTTP_502',
      upstreamCode: 'HTTP_502',
    });
    const firstDirectSend = jest.fn(async () => { throw direct502(); });
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_routepool_switch',
        object: 'response',
        status: 'completed',
        output_text: 'ok',
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.4',
        },
        decision: {
          routeName: 'longcontext',
          pool: [providerKey],
          routePool: [firstProviderKey, secondProviderKey],
          reason: 'longcontext:token-threshold',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5520,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: '1token',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5520',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_routepool_switch',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'gpt-5.4',
          stream: false,
          input: 'ping',
        },
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(outcome.auditContext.providerKey).toBe(secondProviderKey);
    expect(outcome.response?.data).toMatchObject({ id: 'resp_router_direct_routepool_switch' });
    expect(firstDirectSend).toHaveBeenCalledTimes(1);
    expect(secondDirectSend).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(2);
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('router-direct applies Rust default route plan after current route pool is exhausted by provider errors', async () => {
    jest.resetModules();
    jest.useFakeTimers();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 4444 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const primaryProviderKeys = [
      'ykk.ykk.gpt-5.4-mini',
      'asxs.crsa.gpt-5.4-mini',
      'asxs.crsb.gpt-5.4-mini',
      'XL.key1.gpt-5.4-mini',
      '1token.key1.gpt-5.4-mini',
    ];
    const defaultProviderKey = 'ykk.ykk.gpt-5.3-codex-spark';
    const primaryFailures = [
      { status: 502, message: 'HTTP 502: upstream provider error' },
      { status: 403, message: 'HTTP 403: upstream provider error' },
      { status: 401, message: 'HTTP 401: upstream provider error' },
      { status: 502, message: 'HTTP 502: internal provider response error' },
      { status: 502, message: 'HTTP 502: upstream provider error' },
    ];
    const directError = (failure: { status: number; message: string }) => Object.assign(new Error(failure.message), {
      statusCode: failure.status,
      status: failure.status,
      code: `HTTP_${failure.status}`,
      upstreamCode: `HTTP_${failure.status}`,
    });
    const primaryDirectSends = primaryFailures.map((failure) =>
      jest.fn(async () => { throw directError(failure); })
    );
    const defaultDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_default_route_after_exhausted',
        object: 'response',
        status: 'completed',
        output_text: 'ok',
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const allowedProviders = Array.isArray(metadata.allowedProviders) ? metadata.allowedProviders : [];
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = allowedProviders.includes(defaultProviderKey)
        ? defaultProviderKey
        : primaryProviderKeys.find((candidate) => !excluded.includes(candidate)) ?? primaryProviderKeys[primaryProviderKeys.length - 1];
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: providerKey === defaultProviderKey ? 'gpt-5.3-codex-spark' : 'gpt-5.4-mini',
        },
        decision: {
          routeName: providerKey === defaultProviderKey ? 'default' : 'thinking',
          pool: providerKey === defaultProviderKey
            ? [defaultProviderKey]
            : primaryProviderKeys,
          routePool: providerKey === defaultProviderKey
            ? [defaultProviderKey]
            : primaryProviderKeys,
          reason: providerKey === defaultProviderKey ? 'default:route-contract' : 'thinking:user-input',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      virtualrouter: {
        routingPolicyGroups: {
          gateway_glm_4444: {
            routing: {
              thinking: [
                { id: 'thinking-primary', targets: primaryProviderKeys, priority: 200 },
              ],
              default: [
                { id: 'default-primary', targets: [defaultProviderKey], priority: 100 },
              ],
            },
          },
        },
      },
      httpserver: {
        ports: [{
          port: 4444,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_glm_4444',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_glm_4444', route);
    (server as any).providerHandles = new Map([
      ...primaryProviderKeys.map((providerKey, index) => [providerKey, {
        runtimeKey: providerKey,
        providerId: providerKey.split('.')[0],
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4-mini' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: primaryDirectSends[index],
        },
      }]),
      [defaultProviderKey, {
        runtimeKey: defaultProviderKey,
        providerId: 'ykk',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.3-codex-spark' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: defaultDirectSend,
        },
      }],
    ]);

    const outcomePromise = (server as any).executeRouterDirectPipelineForPort(
      {
        port: 4444,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_glm_4444',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_default_route_after_exhausted',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'gpt-5.5',
          stream: true,
          input: 'ping',
        },
        metadata: {},
      },
    );
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
      await jest.runOnlyPendingTimersAsync();
    }
    const outcome = await outcomePromise;

    expect(outcome.used).toBe(true);
    expect(outcome.auditContext.providerKey).toBe(defaultProviderKey);
    expect(outcome.response?.data).toMatchObject({ id: 'resp_router_direct_default_route_after_exhausted' });
    for (const directSend of primaryDirectSends) {
      expect(directSend).toHaveBeenCalledTimes(1);
    }
    expect(defaultDirectSend).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(6);
    expect(route.mock.calls[5]?.[1]).toEqual(expect.objectContaining({
      allowedProviders: [defaultProviderKey],
      routecodexRoutingPolicyGroup: 'gateway_glm_4444',
    }));
    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('HTTP BLACKBOX: router-direct provider HTTP 401 never enters standard executor', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.5';
    const secondProviderKey = 'llmgate.key1.gpt-5.5';
    const direct401 = Object.assign(new Error('HTTP 401: Upstream authentication failed'), {
      statusCode: 401,
      status: 401,
      code: 'HTTP_401',
    });
    const firstDirectSend = jest.fn(async () => { throw direct401; });
    const secondStandardSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_401_must_not_relay',
        object: 'response',
        status: 'completed',
        output_text: 'ok',
      },
    }));
    const route = jest.fn(() => {
      const providerKey = firstProviderKey;
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'thinking', pool: [firstProviderKey, secondProviderKey], reason: 'thinking:test' },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'llmgate',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: secondStandardSend,
          processIncomingDirect: jest.fn(),
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        }),
      });
      const bodyText = await response.text();

      expect(response.status).toBe(502);
      expect(bodyText).toContain('Upstream provider error');
      expect(bodyText).toContain('upstream_error');
      expect(bodyText).not.toContain('Upstream authentication failed');
      expect(bodyText).not.toContain('HTTP_401');
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(secondStandardSend).not.toHaveBeenCalled();
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
      expect(route).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: router-direct recoverable 502 switches provider before client-visible upstream error', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.4';
    const secondProviderKey = '1token.key1.gpt-5.4';
    const direct502 = Object.assign(new Error('HTTP 502: Upstream provider error'), {
      statusCode: 502,
      status: 502,
      code: 'HTTP_502',
      upstreamCode: 'HTTP_502',
    });
    const firstDirectSend = jest.fn(async () => { throw direct502; });
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_http_502_switched',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_ok',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'pong' },
            ],
          },
        ],
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.4',
        },
        decision: {
          routeName: 'longcontext',
          pool: [providerKey],
          routePool: [firstProviderKey, secondProviderKey],
          reason: 'longcontext:test',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: '1token',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5520',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: false,
          input: 'ping',
        }),
      });
      const bodyText = await response.text();

      expect(response.status).toBe(200);
      expect(bodyText).toContain('resp_router_direct_http_502_switched');
      expect(bodyText).toContain('pong');
      expect(bodyText).not.toContain('HTTP_HANDLER_ERROR');
      expect(bodyText).not.toContain('Upstream provider error');
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(secondDirectSend).toHaveBeenCalledTimes(1);
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
      expect(route).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: router-direct recoverable returned 502 response switches provider before client-visible upstream error', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.4';
    const secondProviderKey = '1token.key1.gpt-5.4';
    const firstDirectSend = jest.fn(async () => ({
      status: 502,
      data: {
        error: {
          message: 'Upstream provider error',
          code: 'HTTP_502',
        },
      },
    }));
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_returned_http_502_switched',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_ok',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'pong' },
            ],
          },
        ],
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.4',
        },
        decision: {
          routeName: 'longcontext',
          pool: [providerKey],
          routePool: [firstProviderKey, secondProviderKey],
          reason: 'longcontext:test-returned-502',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: '1token',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5520',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.4',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_router_direct_returned_http_502_switched',
        object: 'response',
        status: 'completed',
      }));
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(secondDirectSend).toHaveBeenCalledTimes(1);
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
      expect(route).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: router-direct recoverable nested response.status=502 switches provider before client-visible upstream error', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.4-mini';
    const secondProviderKey = 'minimax.key1.MiniMax-M3';
    const firstDirectSend = jest.fn(async () => ({
      response: {
        status: 502,
        data: {
          error: {
            message: 'Upstream provider error',
            code: 'HTTP_502',
          },
        },
      },
      data: {
        error: {
          message: 'Upstream provider error',
          code: 'HTTP_502',
        },
      },
    }));
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_nested_response_status_502_switched',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_ok_nested_status',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'pong' },
            ],
          },
        ],
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: providerKey === firstProviderKey ? 'gpt-5.4-mini' : 'MiniMax-M3',
        },
        decision: {
          routeName: 'default',
          pool: [providerKey],
          routePool: [firstProviderKey, secondProviderKey],
          reason: 'default:route-selected',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4-mini' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'minimax',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'MiniMax-M3' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5520',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: false,
          input: 'ping',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_router_direct_nested_response_status_502_switched',
        object: 'response',
        status: 'completed',
      }));
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(secondDirectSend).toHaveBeenCalledTimes(1);
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
      expect(route).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: router-direct responses body error switches provider before client-visible upstream error', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.4-mini';
    const secondProviderKey = 'minimax.key1.MiniMax-M3';
    const firstDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        error: {
          message: 'Upstream provider error',
          code: 'HTTP_502',
          status: 502,
        },
      },
    }));
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_body_error_switched',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_ok_body_error',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'pong' },
            ],
          },
        ],
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: providerKey === firstProviderKey ? 'gpt-5.4-mini' : 'MiniMax-M3',
        },
        decision: {
          routeName: 'default',
          pool: [providerKey],
          routePool: [firstProviderKey, secondProviderKey],
          reason: 'default:route-selected',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4-mini' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'minimax',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'MiniMax-M3' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5520',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: false,
          input: 'ping',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_router_direct_body_error_switched',
        object: 'response',
        status: 'completed',
      }));
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(secondDirectSend).toHaveBeenCalledTimes(1);
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
      expect(route).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: 5520 default mixed-protocol backup relays into Hub after first direct provider fails', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.4-mini';
    const secondProviderKey = 'minimax.key1.MiniMax-M3';
    const firstDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        error: {
          message: 'Upstream provider error',
          code: 'HTTP_502',
          status: 502,
        },
      },
    }));
    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp_router_direct_default_mixed_protocol_relay',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_default_mixed_protocol_relay',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'relay-ok' },
            ],
          },
        ],
      },
      metadata: { relayed: true },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      const isBackup = providerKey === secondProviderKey;
      return {
        target: {
          providerKey,
          providerType: isBackup ? 'anthropic' : 'openai',
          outboundProfile: isBackup ? 'anthropic-messages' : 'openai-responses',
          runtimeKey: providerKey,
          modelId: isBackup ? 'MiniMax-M3' : 'gpt-5.4-mini',
        },
        decision: {
          routeName: 'default',
          pool: [providerKey],
          routePool: [firstProviderKey, secondProviderKey],
          reason: 'default:route-selected',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);
    jest.spyOn(server as any, 'executePipeline').mockImplementation(executePipeline);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4-mini' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'minimax',
        providerType: 'anthropic',
        providerFamily: 'anthropic',
        providerProtocol: 'anthropic-messages',
        runtime: { modelId: 'MiniMax-M3' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: jest.fn(async () => {
            throw new Error('mixed-protocol backup must relay through hub instead of direct send');
          }),
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5520',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: false,
          input: 'ping',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_router_direct_default_mixed_protocol_relay',
        object: 'response',
        status: 'completed',
      }));
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(executePipeline).toHaveBeenCalledTimes(1);
      expect(route).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: router-direct relays selected responses provider when target outboundProfile is chat', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerKey = 'tokenrelay.key1.deepseek-v4-pro';
    const directSend = jest.fn(async () => {
      throw new Error('responses process=chat provider must not receive raw router-direct payload');
    });
    const executePipeline = jest.fn(async (input: Record<string, unknown>) => {
      const metadata = input.metadata && typeof input.metadata === 'object'
        ? (input.metadata as Record<string, unknown>)
        : {};
      const preselected = readRuntimeControlProjection(metadata).preselectedRoute;
      expect((preselected?.target as Record<string, unknown> | undefined)?.providerKey).toBe(providerKey);
      expect((preselected?.target as Record<string, unknown> | undefined)?.outboundProfile).toBe('openai-chat');
      return {
        status: 200,
        body: {
          id: 'resp_router_direct_responses_chat_profile_relay',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_router_direct_responses_chat_profile_relay',
              status: 'completed',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'relay-chat-profile-ok' },
              ],
            },
          ],
        },
        metadata: { relayed: true },
      };
    });
    const route = jest.fn(() => ({
      target: {
        providerKey,
        providerType: 'responses',
        outboundProfile: 'openai-chat',
        runtimeKey: providerKey,
        modelId: 'deepseek-v4-pro',
        responsesConfig: { process: 'chat', streaming: 'always' },
      },
      decision: {
        routeName: 'thinking',
        pool: [providerKey],
        routePool: [providerKey],
        reason: 'thinking:user-input',
      },
      diagnostics: {},
    }));

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5555', route);
    jest.spyOn(server as any, 'executePipeline').mockImplementation(executePipeline);
    (server as any).providerHandles = new Map([
      [providerKey, {
        runtimeKey: providerKey,
        providerId: 'tokenrelay',
        providerType: 'responses',
        providerFamily: 'responses',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'deepseek-v4-pro' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: directSend,
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: true,
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'historical turn' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'history' }] },
            { role: 'user', content: [{ type: 'input_text', text: 'reply ok' }] },
          ],
        }),
      });
      const bodyText = await response.text();

      expect(response.status).toBe(200);
      expect(bodyText).toContain('resp_router_direct_responses_chat_profile_relay');
      expect(bodyText).toContain('relay-chat-profile-ok');
      expect(directSend).not.toHaveBeenCalled();
      expect(executePipeline).toHaveBeenCalledTimes(1);
      expect(route).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: 5520 default reroutes even when first provider runtime registry only exposes alias runtime key', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.4-mini';
    const firstRuntimeKey = 'asxs.crsa';
    const secondProviderKey = '1token.key1.gpt-5.4-mini';
    const firstDirectSend = jest.fn(async () => {
      throw Object.assign(new Error('HTTP 503: upstream provider error'), {
        statusCode: 503,
        status: 503,
        code: 'HTTP_503',
        upstreamCode: 'HTTP_503',
      });
    });
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_default_alias_runtime_switch',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_default_alias_runtime_switch',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'pong' },
            ],
          },
        ],
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = readRuntimeControlProjection(metadata).retryProviderKey;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey === firstProviderKey ? firstRuntimeKey : secondProviderKey,
          modelId: 'gpt-5.4-mini',
        },
        decision: {
          routeName: 'default',
          pool: [providerKey],
          routePool: [firstProviderKey, secondProviderKey],
          reason: 'default:route-selected',
        },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5520',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    installNativeHubPipelineRoute(server, 'gateway_priority_5520', route);
    (server as any).providerHandles = new Map([
      [firstRuntimeKey, {
        runtimeKey: firstRuntimeKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4-mini' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: '1token',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.4-mini' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);
    (server as any).providerKeyToRuntimeKey = new Map([
      [firstProviderKey, firstRuntimeKey],
      [firstRuntimeKey, firstRuntimeKey],
      [secondProviderKey, secondProviderKey],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5520',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: false,
          input: 'ping',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_router_direct_default_alias_runtime_switch',
        object: 'response',
        status: 'completed',
      }));
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(secondDirectSend).toHaveBeenCalledTimes(1);
      expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
      expect(route).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  }, 15000);

});
