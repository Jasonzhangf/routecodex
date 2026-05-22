import type { ModuleDependencies } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { WindsurfChatProvider } from '../../providers/core/runtime/windsurf-chat-provider.js';
import type { OpenAIStandardConfig } from '../../providers/core/api/provider-config.js';
import type {
  ExecutionHarness,
  HarnessExecuteContext,
  ProviderHarnessRuntime,
  WindsurfStaticRequestHarnessInput,
  WindsurfStaticRequestHarnessResult,
  WindsurfStaticRequestLens,
} from '../types.js';

function deepClone<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function createNoopDependencies(): ModuleDependencies {
  const noop = () => {};
  return {
    logger: {
      logModule: noop,
      logError: noop,
      logDebug: noop,
      logPipeline: noop,
      logRequest: noop,
      logResponse: noop,
      logTransformation: noop,
      logProviderRequest: noop,
      getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
      getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }),
      getRecentLogs: () => [],
      getTransformationLogs: () => [],
      getProviderLogs: () => [],
      getStatistics: () => ({
        totalLogs: 0,
        logsByLevel: {},
        logsByCategory: {},
        logsByPipeline: {},
        transformationCount: 0,
        providerRequestCount: 0,
      }),
      clearLogs: noop,
      exportLogs: () => [],
      log: noop,
    },
    errorHandlingCenter: {
      handleError: async () => {},
      createContext: () => ({}),
      getStatistics: () => ({}),
    },
    debugCenter: {
      logDebug: noop,
      logError: noop,
      logModule: noop,
      processDebugEvent: noop,
      getLogs: () => [],
    },
  };
}

type WindsurfProviderWithInternals = {
  initialize?: () => Promise<void>;
  preprocessRequest?: (
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  parseCascadeSemanticRoundtripSync?: (messages: unknown) => unknown[];
};

function buildWindsurfConfigFromRuntime(runtime: ProviderHarnessRuntime): OpenAIStandardConfig {
  const providerType = String(runtime.providerType || 'openai');
  const auth = runtime.auth || { type: 'apikey' };
  return {
    type: 'openai-standard',
    config: {
      providerType,
      baseUrl: String(runtime.baseUrl || runtime.endpoint || ''),
      model: String(runtime.defaultModel || 'gpt-5.4-medium'),
      runtimeKey: runtime.runtimeKey,
      auth: {
        type: auth.type,
        apiKey: typeof auth.value === 'string' ? auth.value : '',
        tokenFile: auth.tokenFile,
        tokenUrl: auth.tokenUrl,
        deviceCodeUrl: auth.deviceCodeUrl,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        scopes: auth.scopes,
        authorizationUrl: auth.authorizationUrl,
        userInfoUrl: auth.userInfoUrl,
        refreshUrl: auth.refreshUrl,
        oauthProviderId: auth.oauthProviderId,
        rawType: auth.rawType,
        mobile: auth.mobile,
        account: auth.account,
        username: auth.username,
        password: auth.password,
        accountFile: auth.accountFile,
        accountAlias: auth.accountAlias,
      },
      headers: runtime.headers,
      timeoutMs: runtime.timeoutMs,
      maxRetries: runtime.maxRetries,
    },
  } as OpenAIStandardConfig;
}

export class WindsurfStaticRequestHarness
  implements ExecutionHarness<WindsurfStaticRequestHarnessInput, WindsurfStaticRequestHarnessResult>
{
  readonly id = 'provider.windsurf.static-request';
  readonly description = 'Build static windsurf request lens without network I/O';
  private readonly providers = new Map<string, WindsurfProviderWithInternals>();

  constructor(private readonly defaultDependencies?: ModuleDependencies) {}

  private async ensureProvider(
    runtime: ProviderHarnessRuntime,
    dependencies?: ModuleDependencies,
  ): Promise<WindsurfProviderWithInternals> {
    const key = runtime.runtimeKey || `${runtime.providerKey || runtime.providerId}:${runtime.defaultModel || ''}`;
    const cached = this.providers.get(key);
    if (cached) {
      return cached;
    }
    const provider = new WindsurfChatProvider(
      buildWindsurfConfigFromRuntime(runtime),
      dependencies ?? this.defaultDependencies ?? createNoopDependencies(),
    ) as unknown as WindsurfProviderWithInternals;
    if (typeof provider.initialize === 'function') {
      await provider.initialize();
    }
    this.providers.set(key, provider);
    return provider;
  }

  async executeForward(
    input: WindsurfStaticRequestHarnessInput,
    _context?: HarnessExecuteContext,
  ): Promise<WindsurfStaticRequestHarnessResult> {
    const provider = await this.ensureProvider(input.runtime, input.dependencies);
    const cloned = deepClone(input.request);
    const preprocess = typeof provider.preprocessRequest === 'function'
      ? await provider.preprocessRequest(cloned)
      : cloned;
    if (typeof provider.parseCascadeSemanticRoundtripSync !== 'function') {
      throw new Error('[windsurf-static-request-harness] parseCascadeSemanticRoundtripSync unavailable');
    }

    const processedBody = preprocess && typeof preprocess === 'object'
      ? (preprocess as Record<string, unknown>).body
      : undefined;
    const body = processedBody && typeof processedBody === 'object'
      ? processedBody as Record<string, unknown>
      : {};
    const messages = body.messages;
    const semanticConversation = provider.parseCascadeSemanticRoundtripSync(messages);

    return {
      preprocess: preprocess as Record<string, unknown>,
      semanticConversation,
      outboundRequest: {},
      lens: {
        metadataKeys: [],
        metadataIdentity: {},
        topLevelKeys: [],
        completionsRequestKeys: [],
        configuration: null,
        systemPromptPresent: false,
        systemPromptPreview: null,
        promptRowKinds: [],
        promptRowKeyMatrix: [],
      },
    };
  }
}
