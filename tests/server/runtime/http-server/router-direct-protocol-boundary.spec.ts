import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { readRuntimeControlProjection } from '../../../../src/server/runtime/http-server/metadata-center/request-truth-readers.js';

type NativeRouteMock = (request: Record<string, unknown>, metadata: Record<string, unknown>) => unknown;

let activeNativeRouteMock: NativeRouteMock | undefined;

const executeHubPipelineNativeMock = jest.fn(() => {
  throw new Error('router-direct protocol-boundary test must not enter native HubPipeline execute');
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
}));

describe('router direct protocol boundary', () => {
  afterEach(() => {
    jest.useRealTimers();
    activeNativeRouteMock = undefined;
    executeHubPipelineNativeMock.mockClear();
  });

  function createRouterServer() {
    return {
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any;
  }

  function attachRouterPort(server: any): void {
    server.userConfig = {
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
    server.hubPipeline = 'mock_hub_pipeline_handle';
    server.hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', 'mock_hub_pipeline_handle'],
    ]);
    server.pipelineRuntimeConfigByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', { routingProviderIds: [] }],
    ]);
  }

  function attachRouterPortWithStoplessRelay(server: any): void {
    server.userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: {
            enabled: true,
            includeDirect: true,
          },
        }],
      },
      servertool: {
        apply_patch: {
          mode: 'client',
        },
      },
    };
    server.hubPipeline = 'mock_hub_pipeline_handle';
    server.hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', 'mock_hub_pipeline_handle'],
    ]);
    server.pipelineRuntimeConfigByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', { routingProviderIds: [] }],
    ]);
  }

  function installNativeHubPipelineRoute(server: any, route: NativeRouteMock): void {
    activeNativeRouteMock = route;
    server.hubPipeline = 'mock_hub_pipeline_handle';
    server.hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', 'mock_hub_pipeline_handle'],
    ]);
    server.pipelineRuntimeConfigByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', { routingProviderIds: [] }],
    ]);
  }

  function bindTestRequestTruth(metadata: Record<string, unknown>, requestId: string, sessionId: string): void {
    MetadataCenter.attach(metadata).writeRequestTruth(
      'sessionId',
      sessionId,
      {
        module: 'tests/server/runtime/http-server/router-direct-protocol-boundary.spec.ts',
        symbol: 'buildResponsesInput',
        stage: 'test_request_truth',
      },
      requestId
    );
  }

  function buildResponsesInput(
    requestId: string,
    sessionId = 'router-direct-protocol-boundary',
  ) {
    const metadata: Record<string, unknown> = { sessionId };
    bindTestRequestTruth(metadata, requestId, sessionId);
    return {
      requestId,
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'router-gpt-5.5',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'search' }] }],
      },
      metadata,
    };
  }

  it('relays into Hub when router-direct reports protocol mismatch', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'relay_after_protocol_mismatch', object: 'response' },
      metadata: { relayed: true },
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const result = await (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_no_relay'),
    );

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 200,
      body: { id: 'relay_after_protocol_mismatch', object: 'response' },
      metadata: { relayed: true },
    });
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(1);
  });


  it('reuses preselected route on router-direct relayable skip so Hub does not route twice', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const preselectedRoute = {
      target: {
        providerKey: 'minimax.key1.MiniMax-M3',
        providerType: 'anthropic',
        runtimeKey: 'minimax.key1.MiniMax-M3',
        modelId: 'MiniMax-M3',
      },
      decision: {
        routeName: 'search',
        pool: ['minimax.key1.MiniMax-M3'],
        poolId: 'gateway-priority-5555-priority-search',
        reasoning: 'search:last-tool-search',
      },
      diagnostics: { reused: true },
    };
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=anthropic-messages',
      preselectedRoute,
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'relay_after_protocol_mismatch_preselected', object: 'response' },
      metadata: { relayed: true },
    } as any);

    await (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_preselected_route'),
    );

    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    const relayMetadata = executePipelineSpy.mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(relayMetadata.__rt as Record<string, unknown> | undefined).not.toEqual(expect.objectContaining({
      preselectedRoute,
    }));
    expect(readRuntimeControlProjection(relayMetadata).preselectedRoute).toEqual(preselectedRoute);
  });

  it('writes preselected provider protocol from provider runtime when target has no outboundProfile', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    (server as any).providerHandles = new Map([[
      'minimax.key1.MiniMax-M3',
      {
        runtimeKey: 'minimax.key1.MiniMax-M3',
        providerId: 'minimax',
        providerType: 'anthropic',
        providerFamily: 'anthropic',
        providerProtocol: 'anthropic-messages',
        runtime: {},
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: async () => ({ status: 200, data: { ok: true } }),
        },
      },
    ]]);
    const preselectedRoute = {
      target: {
        providerKey: 'minimax.key1.MiniMax-M3',
        providerType: 'anthropic',
        runtimeKey: 'minimax.key1.MiniMax-M3',
        modelId: 'MiniMax-M3',
      },
      decision: {
        routeName: 'thinking',
        pool: ['minimax.key1.MiniMax-M3'],
        poolId: 'gateway-priority-5555-priority-thinking',
        reasoning: 'thinking:last-tool-thinking',
      },
      diagnostics: { reused: true },
    };
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=anthropic-messages',
      preselectedRoute,
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'relay_after_protocol_runtime_protocol', object: 'response' },
      metadata: { relayed: true },
    } as any);

    await (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_runtime_protocol'),
    );

    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    const relayMetadata = executePipelineSpy.mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    const runtimeControl = readRuntimeControlProjection(relayMetadata);
    expect(runtimeControl.preselectedRoute).toEqual(preselectedRoute);
    expect(runtimeControl.providerProtocol).toBe('anthropic-messages');
  });

  it('preserves MetadataCenter routeHint when router-direct rebuilds metadata for VR', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    const routeSpy = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      expect(readRuntimeControlProjection(metadata).routeHint).toBe('search');
      expect(
        (metadata.metadataCenterSnapshot as Record<string, unknown> | undefined)?.runtimeControl
      ).toEqual(expect.objectContaining({ routeHint: 'search' }));
      return {
        target: {
          providerKey: 'anthropic.key1.claude',
          providerType: 'anthropic',
          runtimeKey: 'anthropic.key1.claude',
          outboundProfile: 'anthropic-messages',
        },
        decision: {
          routeName: 'search',
          pool: ['anthropic.key1.claude'],
          reasoning: 'route_hint:search',
        },
        diagnostics: {},
      };
    });
    attachRouterPort(server as any);
    installNativeHubPipelineRoute(server as any, routeSpy);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'relay_after_route_hint_preserved', object: 'response' },
      metadata: { relayed: true },
    } as any);

    await (server as any).executePortAwarePipeline(
      5555,
      {
        ...buildResponsesInput('req_router_direct_route_hint_preserved'),
        headers: { 'x-route-hint': 'search' },
      },
    );

    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    const relayMetadata = executePipelineSpy.mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(readRuntimeControlProjection(relayMetadata).preselectedRoute).toEqual(expect.objectContaining({
      decision: expect.objectContaining({
        reasoning: 'route_hint:search',
      }),
    }));
  });

  it('does not record router-direct storm backoff when protocol mismatch is relayed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 202,
      body: { id: 'relay_after_protocol_mismatch_repeat', object: 'response' },
      metadata: {},
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_1', 'router-direct-protocol-mismatch-storm'),
    )).resolves.toMatchObject({
      status: 202,
      body: { id: 'relay_after_protocol_mismatch_repeat', object: 'response' },
    });

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_2', 'router-direct-protocol-mismatch-storm'),
    )).resolves.toMatchObject({
      status: 202,
      body: { id: 'relay_after_protocol_mismatch_repeat', object: 'response' },
    });

    await jest.advanceTimersByTimeAsync(1000);

    expect(executePipelineSpy).toHaveBeenCalledTimes(2);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff_wait')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(2);
  });

  it('fails fast and records storm backoff for non-relayable router-direct skip errors', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'provider not found for runtimeKey: missing.runtime',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_missing_runtime', 'router-direct-missing-runtime-storm'),
    )).rejects.toThrow('router-direct failed without relay: provider not found for runtimeKey: missing.runtime');

    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(1);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
  });

  it('fails fast instead of relaying when same-protocol direct reports tool or stopless relay reasons', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const relayReasons = [
      'client_tools_require_hub_relay',
      'stopless_servertool_requires_hub_relay',
    ];

    for (const reason of relayReasons) {
      const server = new RouteCodexHttpServer(createRouterServer());
      attachRouterPort(server as any);
      jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
        used: false,
        reason,
      } as any);
      const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
      const logStageSpy = jest.spyOn(server as any, 'logStage');

      await expect((server as any).executePortAwarePipeline(
        5555,
        buildResponsesInput(`req_router_direct_${reason}`),
      )).rejects.toThrow(`router-direct failed without relay: ${reason}`);

      expect(executePipelineSpy).not.toHaveBeenCalled();
      expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(1);
      expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(0);
    }
  });

  it('backs off repeated router-direct VR provider-unavailable failures without rewriting the error', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const error = Object.assign(
      new Error('No available providers after applying routing instructions'),
      { code: 'PROVIDER_NOT_AVAILABLE' },
    );
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockRejectedValue(error);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_vr_1', 'router-direct-vr-provider-unavailable-storm'),
    )).rejects.toThrow('No available providers after applying routing instructions');

    const second = (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_vr_2', 'router-direct-vr-provider-unavailable-storm'),
    );
    const secondExpectation = expect(second)
      .rejects.toThrow('No available providers after applying routing instructions');
    await jest.advanceTimersByTimeAsync(999);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff_wait')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    await secondExpectation;

    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
  });

  it('returns a protocol mismatch skip from router-direct port pipeline without provider transport', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const runtimeKey = 'anthropic.key1.claude-test';
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const directSend = jest.fn();
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'anthropic',
      providerType: 'anthropic',
      providerFamily: 'anthropic',
      providerProtocol: 'anthropic-messages',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: directSend,
        processIncomingDirect: directSend,
      },
    }]]);
    installNativeHubPipelineRoute(server as any, () => ({
      target: {
        providerKey: runtimeKey,
        providerType: 'anthropic',
        runtimeKey,
        modelId: 'claude-test',
      },
      decision: { routeName: 'search', pool: [runtimeKey] },
      diagnostics: {},
    }));

    const result = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      buildResponsesInput('req_router_direct_protocol_mismatch_skip'),
    );

    expect(result).toMatchObject({
      used: false,
      reason: expect.stringContaining('protocol mismatch'),
    });
    expect(result).not.toHaveProperty('requiresHubRelay');
    expect(directSend).not.toHaveBeenCalled();
  });

  it('fails fast on direct route pool exhaustion without local backoff wait', async () => {
    jest.useFakeTimers();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const routeError = Object.assign(
      new Error('All providers unavailable for model mini27.MiniMax-M2.7'),
      { code: 'PROVIDER_NOT_AVAILABLE' },
    );
    installNativeHubPipelineRoute(server as any, () => {
      throw routeError;
    });
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const pending = (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      buildResponsesInput('req_router_direct_route_failed_no_inner_record'),
    );
    const expectation = expect(pending).rejects.toThrow('All providers unavailable for model mini27.MiniMax-M2.7');

    await jest.advanceTimersByTimeAsync(1_000);
    await expectation;

    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.pool_exhausted.backoff_wait')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.pool_exhausted.backoff_wait.completed')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.route_failed')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
  });
});
