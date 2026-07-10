import { jest } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const BRIDGE_TS_MODULE_PATH = path.resolve(process.cwd(), 'src/modules/llmswitch/bridge.ts');
const BRIDGE_INDEX_TS_MODULE_PATH = path.resolve(process.cwd(), 'src/modules/llmswitch/bridge/index.ts');
const ROUTING_INTEGRATIONS_TS_PATH = path.resolve(process.cwd(), 'src/modules/llmswitch/bridge/routing-integrations.ts');
const RUNTIME_INTEGRATIONS_TS_PATH = path.resolve(process.cwd(), 'src/modules/llmswitch/bridge/runtime-integrations.ts');
const HUB_PIPELINE_HANDLE_TS_PATH = path.resolve(process.cwd(), 'src/server/runtime/http-server/hub-pipeline-handle.ts');

function buildRoutingBridgeMock(captured: { policy?: unknown }) {
  const createHubPipelineNative = (config: any) => {
    captured.policy = config?.policy;
    return 'mock_hub_pipeline_handle';
  };
  const passthroughRecord = (input: any) => input ?? {};
  return {
    bootstrapVirtualRouterConfig: async (input: any) => ({ config: input, runtime: {}, targetRuntime: {} }),
    compileRouteCodexRuntimeManifest: async (input: any) => buildRuntimeManifest(input),
    compileRouteCodexRuntimeManifestSync: (input: any) => buildRuntimeManifest(input),
    materializeRouteCodexUserConfigFromManifestSync: (userConfig: any) => userConfig ?? {},
    buildRouteCodexProviderProfilesSync: () => ({ profiles: [] }),
    buildRouteCodexForwarderProfilesSync: () => ({}),
    resolvePrimaryRouteCodexRoutingPolicyGroupSync: () => 'default',
    collectRouteCodexV2ConfigSourceErrorsSync: () => [],
    normalizeRouteCodexV2RuntimeSourceSync: passthroughRecord,
    extractRouteCodexMaterializedProviderConfigsSync: () => null,
    parseRouteCodexTomlRecord: async () => ({}),
    parseRouteCodexTomlRecordSync: () => ({}),
    serializeRouteCodexTomlRecord: async () => '',
    serializeRouteCodexTomlRecordSync: () => '',
    updateRouteCodexTomlStringScalarInTable: async (input: any) => input?.raw ?? '',
    updateRouteCodexTomlStringScalarInTableSync: (input: any) => input?.raw ?? '',
    decodeRouteCodexUserConfigTextSync: () => ({ format: 'toml', parsed: {} }),
    decodeRouteCodexProviderConfigTextSync: () => ({ format: 'toml', parsed: {} }),
    detectRouteCodexUserConfigFormatSync: () => 'toml',
    detectRouteCodexProviderConfigFormatSync: () => 'toml',
    writeRouteCodexUserConfigFileNativeSync: (input: any) => ({
      path: input?.configPath ?? '',
      format: 'toml',
      raw: '',
      parsed: input?.parsed ?? {},
    }),
    writeRouteCodexProviderConfigFileNativeSync: (input: any) => ({
      path: input?.configPath ?? '',
      format: 'toml',
      raw: '',
      parsed: input?.parsed ?? {},
    }),
    updateRouteCodexUserConfigStringScalarNativeSync: (input: any) => ({
      path: input?.configPath ?? '',
      format: 'toml',
      raw: '',
      parsed: {},
    }),
    loadRouteCodexConfigNativeSync: () => ({
      configPath: tempConfigPath,
      userConfig: {},
      providerProfiles: { profiles: [] },
    }),
    coerceRouteCodexProviderConfigV2: async (parsed: any) => parsed ?? null,
    coerceRouteCodexProviderConfigV2Sync: (parsed: any) => parsed ?? null,
    planRouteCodexProviderConfigV2FilesSync: () => [],
    resolveRouteCodexProviderConfigV2IdentitySync: (input: any) => ({
      providerId: input?.dirId ?? input?.fileName ?? 'provider',
      provider: input?.provider ?? {},
    }),
    loadRouteCodexProviderConfigsV2FromRootSync: () => ({}),
    planAuthFileResolutionNativeSync: (input: any) => ({
      kind: 'literal',
      value: input?.keyId ?? '',
      cacheKey: input?.keyId ?? '',
    }),
    resolveAuthFileKeyNativeSync: (input: any) => ({
      kind: 'literal',
      value: input?.keyId ?? '',
      cacheKey: input?.keyId ?? '',
    }),
    planProviderConfigRootNativeSync: (rootDir?: string) => ({ rootDir: rootDir ?? path.join(os.homedir(), '.rcc', 'provider') }),
    planRouteCodexConfigLoaderPathsNativeSync: (input: any) => ({
      explicitPath: input?.explicitPath,
      providerRootDir: input?.routecodexProviderDir ?? input?.rccProviderDir,
    }),
    resolveRouteCodexConfigPathNativeSync: () => tempConfigPath,
    resolveRccUserDirNativeSync: (homeDir?: string) => path.join(homeDir ?? os.homedir(), '.rcc'),
    resolveRccPathNativeSync: (segments: string[] = [], homeDir?: string) => path.join(homeDir ?? os.homedir(), '.rcc', ...segments),
    resolveRccSnapshotsDirNativeSync: (homeDir?: string) => path.join(homeDir ?? os.homedir(), '.rcc', 'snapshots'),
    createHubPipelineNative,
    executeHubPipelineNative: () => ({ metadata: {} }),
    updateHubPipelineVirtualRouterConfigNative: () => {},
    updateHubPipelineEngineDepsNative: () => {},
    routeHubPipelineVirtualRouterNative: async () => ({ diagnostics: {} }),
    diagnoseHubPipelineVirtualRouterNative: async () => ({ diagnostics: {} }),
    getHubPipelineVirtualRouterStatusNative: async () => ({}),
    markHubPipelineVirtualRouterConcurrencyScopeBusyNative: () => {},
    markHubPipelineVirtualRouterConcurrencyScopeIdleNative: () => {},
    disposeHubPipelineNative: () => {},
  };
}

function buildRuntimeManifest(input: any) {
  return {
    manifestVersion: 'routecodex.runtime-config.v1',
    virtualRouterBootstrapInput: input?.virtualrouter ?? input ?? {},
    pipelineRuntimeConfig: {
      routingProviderIds: [],
      routingTiersByRoute: {},
    },
    providerIds: [],
    forwarderIds: [],
  };
}

function buildRuntimeBridgeMock() {
  return {
    preloadCriticalBridgeRuntimeModules: async () => ({ loaded: [] }),
    captureResponsesRequestContextForRequest: async () => {},
    recordResponsesResponseForRequest: async () => {},
    lookupResponsesContinuationByResponseId: async () => null,
    rebindResponsesConversationRequestId: async () => {},
    clearResponsesConversationByRequestId: async () => {},
    finalizeResponsesConversationRequestRetention: async () => {},
    resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
    resumeLatestResponsesContinuationByScope: async () => null,
    materializeLatestResponsesContinuationByScope: async () => null,
    clearAllResponsesConversationState: async () => {},
    resetResponsesConversationStateForRestartSimulation: async () => {},
    clearUnresolvedResponsesConversationRequests: async () => 0,
    writeSnapshotViaHooks: async () => {},
    buildResponsesJsonFromSseStreamWithNative: async () => ({}),
    reportProviderErrorToRouterPolicy: async (event: unknown) => event,
    reportProviderSuccessToRouterPolicy: async (event: unknown) => event,
  };
}

function buildRootBridgeMock(captured: { policy?: unknown }) {
  return {
    getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
    extractSessionIdentifiersFromMetadata: () => ({}),
    extractContinuationContextSessionIdentifiersFromMetadata: () => ({}),
    extractAntigravityGeminiSessionId: () => undefined,
    cacheAntigravitySessionSignature: () => {},
    lookupAntigravitySessionSignatureEntry: () => undefined,
    getAntigravityLatestSignatureSessionIdForAlias: () => undefined,
    resetAntigravitySessionSignatureCachesForTests: () => {},
    warmupAntigravitySessionSignatureModule: async () => {},
    loadRoutingInstructionStateSync: () => null,
    saveRoutingInstructionStateAsync: () => {},
    saveRoutingInstructionStateSync: () => {},
    syncReasoningStopModeFromRequest: () => {},
    sanitizeFollowupText: (value: string) => value,
    createSnapshotRecorder: () => ({}) as any,
    convertProviderResponse: async (value: any) => value,
    createCoreQuotaManager: async () => null,
    deriveFinishReasonNative: () => undefined,
    mapChatToolsToBridgeJson: async () => [],
    planResponsesHandlerEntry: async () => ({ mode: 'passthrough' }),
    normalizeAssistantTextToToolCallsJson: async () => ({ toolCalls: [] }),
    buildAnthropicResponseFromChatJson: async (payload: unknown) => payload,
    injectMcpToolsForChatJson: async (payload: unknown) => payload,
    injectMcpToolsForResponsesJson: async (payload: unknown) => payload,
    sanitizeProviderOutboundPayload: async (payload: unknown) => payload,
    convertResponsesRequestToChatNative: (payload: unknown) => ({ payload }),
    evaluateResponsesDirectRouteDecisionNative: async () => ({ mode: 'passthrough' }),
    hasDeclaredApplyPatchToolNative: () => false,
    projectSseErrorEventPayloadNative: () => ({}),
    isToolCallContinuationResponseNative: () => false,
    classifyProviderFailure: () => ({ code: 'UNKNOWN', retryable: false }),
    getNetworkErrorCodes: () => [],
    updateResponsesContractProbeFromSseChunkNative: () => ({}),
    buildResponsesTerminalSseFramesFromProbeNative: () => [],
    buildResponsesRequestFromChat: async () => ({}),
    ensureResponsesInstructions: async () => {},
    createResponsesSseToJsonConverter: async () => ({ convertSseToJson: async () => ({}) }),
    createResponsesJsonToSseConverter: async () => ({ convertResponseToJsonToSse: async () => ({}) }),
    ...buildRuntimeBridgeMock(),
    ...buildRoutingBridgeMock(captured),
  };
}

async function installBridgeMocks(captured: { policy?: unknown }): Promise<void> {
  const root = () => buildRootBridgeMock(captured);
  const routing = () => buildRoutingBridgeMock(captured);
  const runtime = () => buildRuntimeBridgeMock();
  const hubPipelineHandle = () => ({
    readHubPipelineNativeHandle: (pipeline: unknown) => {
      if (typeof pipeline === 'string' && pipeline.trim()) {
        return pipeline;
      }
      return null;
    },
  });
  jest.unstable_mockModule(BRIDGE_TS_MODULE_PATH, root);
  jest.unstable_mockModule(BRIDGE_INDEX_TS_MODULE_PATH, root);
  jest.unstable_mockModule(ROUTING_INTEGRATIONS_TS_PATH, routing);
  jest.unstable_mockModule(RUNTIME_INTEGRATIONS_TS_PATH, runtime);
  jest.unstable_mockModule(HUB_PIPELINE_HANDLE_TS_PATH, hubPipelineHandle);
}

describe('RouteCodexHttpServer hub policy injection', () => {
  let tempConfigPath = '';

  afterEach(async () => {
    delete process.env.ROUTECODEX_HUB_POLICY_MODE;
    delete process.env.ROUTECODEX_HUB_POLICY_SAMPLE_RATE;
    if (tempConfigPath) {
      await fs.rm(path.dirname(tempConfigPath), { recursive: true, force: true });
      tempConfigPath = '';
    }
  });

  async function createTempUserConfig(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-hub-policy-'));
    const filePath = path.join(dir, 'config.json');
    const config = {
      httpserver: {
        ports: [
          {
            port: 5520,
            host: '127.0.0.1',
            mode: 'router',
            routingPolicyGroup: 'default',
          },
        ],
      },
      virtualrouterMode: 'v1',
      virtualrouter: {
        routingPolicyGroups: {
          default: { routing: { default: [{ id: 'default', targets: ['mock.dummy'] }] } },
        },
        providers: {
          mock: {
            type: 'mock',
            endpoint: 'mock://',
            auth: { type: 'apiKey', value: 'dummy_dummy_dummy' },
            models: { dummy: {} },
          },
        },
        routing: { default: ['mock.dummy'] },
      },
    };
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
    return filePath;
  }

  async function initializeServerAndCapturePolicy(): Promise<unknown> {
    const captured: { policy?: unknown } = {};
    jest.resetModules();
    await installBridgeMocks(captured);

    const { RouteCodexHttpServer } = await import('../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: tempConfigPath,
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    (server as any).managerDaemon = {
      getModule: () => undefined,
    };

    const userConfigRaw = JSON.parse(await fs.readFile(tempConfigPath, 'utf8'));
    await server.initializeWithUserConfig(userConfigRaw);
    return captured.policy;
  }

  it('injects hubConfig.policy when ROUTECODEX_HUB_POLICY_MODE=observe', async () => {
    process.env.ROUTECODEX_HUB_POLICY_MODE = 'observe';
    process.env.ROUTECODEX_HUB_POLICY_SAMPLE_RATE = '0.25';
    tempConfigPath = await createTempUserConfig();

    await expect(initializeServerAndCapturePolicy()).resolves.toEqual({
      mode: 'observe',
      sampleRate: 0.25,
    });
  });

  it('injects hubConfig.policy by default (enforce)', async () => {
    tempConfigPath = await createTempUserConfig();

    await expect(initializeServerAndCapturePolicy()).resolves.toEqual({ mode: 'enforce' });
  });

  it('does not inject hubConfig.policy when ROUTECODEX_HUB_POLICY_MODE=off', async () => {
    process.env.ROUTECODEX_HUB_POLICY_MODE = 'off';
    tempConfigPath = await createTempUserConfig();

    await expect(initializeServerAndCapturePolicy()).resolves.toBeUndefined();
  });
});
