// Minimal user config parser used by tests

type UserConfig = {
  virtualrouter?: {
    inputProtocol?: string;
    outputProtocol?: string;
    routing?: Record<string, string[]>;
    providers?: Record<string, {
      auth?: Record<string, string>;
      type?: string;
      baseURL?: string;
      models?: Record<string, {
        maxContext?: number;
        maxTokens?: number;
      }>;
    }>;
  };
  pipelineConfigs?: Record<string, unknown>;
};

type ProviderConfig = {
  auth?: Record<string, string>;
  type?: string;
  baseURL?: string;
  models?: Record<string, {
    maxContext?: number;
    maxTokens?: number;
  }>;
};

export class UserConfigParser {
  parseUserConfig(userConfig: UserConfig) {
    const vr = (userConfig?.virtualrouter ?? {}) as Record<string, unknown>;
    const inputProtocol = String(vr.inputProtocol || 'openai');
    const outputProtocol = String(vr.outputProtocol || 'openai');
    const routing = (vr.routing ?? {}) as Record<string, string[]>;
    const providers = (vr.providers ?? {}) as Record<string, unknown>;

    const authMappings: Record<string, string> = {};
    const usedAuthKeys = new Set<string>();

    const routeTargets: Record<string, Array<unknown>> = {};
    const pipelineConfigs: Record<string, unknown> = {};

    const getAuthActualKey = (provId: string, keyId: string): string => {
      const provider = providers[provId] as ProviderConfig | undefined;
      const authMap = (provider?.auth ?? {}) as Record<string, string>;
      if (!authMap[keyId]) { return keyId; }
      const base = `auth-${keyId}`;
      let candidate = base;
      let i = 0;
      while (usedAuthKeys.has(candidate)) {
        i++;
        candidate = `${base}-${i}`;
      }
      usedAuthKeys.add(candidate);
      authMappings[candidate] = authMap[keyId];
      return candidate;
    };

    for (const [routeName, targetList] of Object.entries(routing)) {
      routeTargets[routeName] = [];
      for (const ref of targetList) {
        // expected format: provider.model.keyId
        const [providerId, modelId, keyId] = String(ref).split('.');
        const prov = providers[providerId] || {};
        const actualKey = getAuthActualKey(providerId, keyId);

        // Build route target
        routeTargets[routeName].push({
          providerId,
          modelId,
          keyId,
          actualKey,
          inputProtocol,
          outputProtocol,
        });

        // Build pipeline config
        const key = `${providerId}.${modelId}.${keyId}`;
        const providerConfig = prov as ProviderConfig;
        pipelineConfigs[key] = {
          provider: {
            type: String(providerConfig.type || providerId),
            baseURL: providerConfig.baseURL,
          },
          model: {
            maxContext: providerConfig.models?.[modelId]?.maxContext,
            maxTokens: providerConfig.models?.[modelId]?.maxTokens,
          },
          keyConfig: {
            keyId,
            actualKey,
            keyType: 'apiKey',
          },
          protocols: { input: inputProtocol, output: outputProtocol },
          compatibility: { type: 'field-mapping', config: {} },
          llmSwitch: { type: 'openai-passthrough', config: {} },
          workflow: { type: 'streaming-control', enabled: true, config: {} },
        };
      }
    }

    // 合并用户自定义的pipelineConfigs
    const userPipelineConfigs = (userConfig?.pipelineConfigs ?? {}) as Record<string, unknown>;
    for (const [key, config] of Object.entries(userPipelineConfigs)) {
      if (!pipelineConfigs[key]) {
        pipelineConfigs[key] = {};
      }
      // 深度合并用户配置
      pipelineConfigs[key] = { ...(pipelineConfigs[key] as Record<string, unknown>), ...(config as Record<string, unknown>) };
    }

    return {
      routeTargets,
      pipelineConfigs,
      moduleConfigs: {},
      authMappings,
    };
  }
}

export default UserConfigParser;

