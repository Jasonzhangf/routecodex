export type ProviderCatalogSdkBinding = {
  family: 'openai-compatible' | 'anthropic-compatible' | 'custom-runtime';
  supported: boolean;
  notes?: string;
};

export type ProviderCatalogWebSearchBinding = {
  engineId: string;
  description: string;
  executionMode: 'direct' | 'servertool';
  providerKey?: string;
  routeTarget?: string;
  modelId?: string;
  directActivation?: 'route' | 'tool';
  default?: boolean;
};

export type ProviderCatalogCapabilities = {
  supportsCoding?: boolean;
  supportsLongContext?: boolean;
  supportsMultimodal?: boolean;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
};

export type InitProviderTemplate = {
  id: string;
  label: string;
  description: string;
  provider: Record<string, unknown>;
  defaultModel: string;
  capabilities?: ProviderCatalogCapabilities;
  sdkBinding?: ProviderCatalogSdkBinding;
  webSearch?: ProviderCatalogWebSearchBinding;
  multimodalRouteTarget?: string;
};

function apikeyAuthEnv(envVar: string) {
  return {
    type: 'apikey',
    apiKey: `\${${envVar}}`
  };
}

const CATALOG: InitProviderTemplate[] = [
  {
    id: 'openai',
    label: 'OpenAI (Chat)',
    description: 'OpenAI-compatible Chat API (/v1/chat/completions)',
    sdkBinding: { family: 'openai-compatible', supported: true },
    capabilities: { supportsReasoning: true, supportsTools: true },
    provider: {
      id: 'openai',
      enabled: true,
      type: 'openai',
      baseURL: 'https://api.openai.com/v1',
      auth: apikeyAuthEnv('OPENAI_API_KEY'),
      models: {
        'gpt-5.2': { supportsStreaming: true },
        'gpt-5.2-codex': { supportsStreaming: true }
      }
    },
    defaultModel: 'gpt-5.2'
  },
  {
    id: 'tab',
    label: 'TAB (Responses)',
    description: 'OpenAI Responses compatible endpoint (/v1/responses)',
    sdkBinding: {
      family: 'openai-compatible',
      supported: true,
      notes: 'Doctor uses the OpenAI-compatible adapter; verify endpoint supports text generation.'
    },
    capabilities: { supportsReasoning: true, supportsTools: true },
    provider: {
      id: 'tab',
      enabled: true,
      type: 'responses',
      baseURL: 'https://api.tabcode.cc/openai',
      auth: apikeyAuthEnv('TAB_API_KEY'),
      models: {
        'gpt-5.2': { supportsStreaming: true },
        'gpt-5.2-codex': { supportsStreaming: true }
      },
      responses: { process: 'chat', streaming: 'always' },
      config: { responses: { streaming: 'always' } }
    },
    defaultModel: 'gpt-5.2'
  },
  {
    id: 'deepseek-web',
    label: 'DeepSeek Web (Account)',
    description: 'DeepSeek Web account provider (chat:deepseek-web compatibility)',
    sdkBinding: {
      family: 'custom-runtime',
      supported: false,
      notes: 'Requires the DeepSeek web-account runtime path rather than direct Vercel AI SDK auth.'
    },
    capabilities: { supportsReasoning: true, supportsTools: true, supportsMultimodal: true },
    webSearch: {
      engineId: 'deepseek:web_search',
      providerKey: 'deepseek-web.deepseek-v4-flash-search-nothinking',
      routeTarget: 'deepseek-web.deepseek-v4-flash-search-nothinking',
      modelId: 'deepseek-v4-flash-search-nothinking',
      description: 'DeepSeek native web_search route backend',
      executionMode: 'direct',
      directActivation: 'route',
      default: true
    },
    multimodalRouteTarget: 'deepseek-web.deepseek-v4-vision',
    provider: {
      id: 'deepseek-web',
      enabled: true,
      type: 'openai',
      baseURL: 'https://chat.deepseek.com',
      compatibilityProfile: 'chat:deepseek-web',
      auth: {
        type: 'deepseek-account',
        entries: [
          {
            alias: '1',
            type: 'deepseek-account',
            tokenFile: '~/.rcc/auth/deepseek-account-1.json'
          }
        ]
      },
      deepseek: {
        strictToolRequired: true,
        toolProtocol: 'text',
        powTimeoutMs: 15000,
        powMaxAttempts: 2,
        sessionReuseTtlMs: 1800000
      },
      models: {
        'deepseek-chat': {
          supportsStreaming: true,
          capabilities: ['web_search', 'multimodal'],
          aliases: ['deepseek-v3', 'deepseek-chat-search', 'deepseek-v3-search', 'deepseek-v4-flash', 'deepseek-v4-flash-nothinking', 'deepseek-v4-flash-search', 'deepseek-v4-flash-search-nothinking', 'deepseek-v4-vision', 'deepseek-v4-vision-nothinking']
        },
        'deepseek-reasoner': {
          supportsStreaming: true,
          capabilities: ['web_search', 'multimodal'],
          aliases: ['deepseek-r1', 'deepseek-reasoner-search', 'deepseek-r1-search', 'deepseek-v4-pro', 'deepseek-v4-pro-nothinking', 'deepseek-v4-pro-search', 'deepseek-v4-pro-search-nothinking']
        }
      }
    },
    defaultModel: 'deepseek-chat'
  },
  {
    id: 'glm',
    label: 'GLM (OpenAI-compatible)',
    description: 'Zhipu/BigModel OpenAI-compatible endpoint',
    sdkBinding: { family: 'openai-compatible', supported: true },
    capabilities: { supportsReasoning: true, supportsTools: true, supportsLongContext: true },
    provider: {
      id: 'glm',
      enabled: true,
      type: 'openai',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      compatibilityProfile: 'chat:glm',
      auth: apikeyAuthEnv('GLM_API_KEY'),
      models: {
        'glm-4.7': { supportsStreaming: true, maxContext: 202752 },
        'glm-4.6': { supportsStreaming: true }
      }
    },
    defaultModel: 'glm-4.7'
  },
  {
    id: 'glm-anthropic',
    label: 'GLM (Anthropic Messages)',
    description: 'GLM via Anthropic Messages wire (/v1/messages upstream, bridged by RouteCodex)',
    sdkBinding: { family: 'anthropic-compatible', supported: true },
    capabilities: { supportsReasoning: true, supportsTools: true },
    provider: {
      id: 'glm',
      enabled: true,
      type: 'anthropic',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      process: 'chat',
      auth: apikeyAuthEnv('GLM_API_KEY'),
      models: {
        'glm-4.6': { supportsStreaming: true }
      }
    },
    defaultModel: 'glm-4.6'
  },
  {
    id: 'kimi',
    label: 'Kimi (OpenAI-compatible)',
    description: 'Moonshot Kimi coding endpoint',
    sdkBinding: { family: 'openai-compatible', supported: true },
    capabilities: { supportsCoding: true, supportsTools: true },
    provider: {
      id: 'kimi',
      enabled: true,
      type: 'openai',
      baseURL: 'https://api.kimi.com/coding/v1',
      auth: apikeyAuthEnv('KIMI_API_KEY'),
      headers: { 'User-Agent': 'KimiCLI/1.0' },
      models: {
        'kimi-for-coding': { supportsStreaming: true }
      }
    },
    defaultModel: 'kimi-for-coding'
  },
  {
    id: 'modelscope',
    label: 'ModelScope (OpenAI-compatible)',
    description: 'ModelScope inference OpenAI-compatible endpoint',
    sdkBinding: { family: 'openai-compatible', supported: true },
    provider: {
      id: 'modelscope',
      enabled: true,
      type: 'openai',
      baseURL: 'https://api-inference.modelscope.cn/v1',
      auth: apikeyAuthEnv('MODELSCOPE_API_KEY'),
      models: {
        'deepseek-ai/DeepSeek-R1-0528': { supportsStreaming: true }
      }
    },
    defaultModel: 'deepseek-ai/DeepSeek-R1-0528'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local OpenAI-compatible)',
    description: 'Local LM Studio server (default: http://127.0.0.1:1234/v1)',
    sdkBinding: { family: 'openai-compatible', supported: true },
    provider: {
      id: 'lmstudio',
      enabled: true,
      type: 'openai',
      baseURL: 'http://127.0.0.1:1234/v1',
      auth: { type: 'apikey', apiKey: '' },
      models: {
        'gpt-oss-20b-mlx': { supportsStreaming: true }
      }
    },
    defaultModel: 'gpt-oss-20b-mlx'
  },
  {
    id: 'mimo',
    label: 'MiMo (OpenAI-compatible)',
    description: 'Xiaomi MiMo OpenAI-compatible endpoint',
    sdkBinding: { family: 'openai-compatible', supported: true },
    provider: {
      id: 'mimo',
      enabled: true,
      type: 'openai',
      baseURL: 'https://api.xiaomimimo.com/v1',
      auth: apikeyAuthEnv('MIMO_API_KEY'),
      models: {
        'mimo-v2-flash': { supportsStreaming: true }
      }
    },
    defaultModel: 'mimo-v2-flash'
  }
];

function dedupeTargets(targets: string[]): string[] {
  return Array.from(new Set(targets.filter((target) => typeof target === 'string' && target.trim()).map((target) => target.trim())));
}

export function getInitProviderCatalog(): InitProviderTemplate[] {
  return CATALOG.map((entry) => ({ ...entry }));
}

export function getInitProviderCatalogEntry(providerId: string): InitProviderTemplate | undefined {
  const normalized = providerId.trim();
  return CATALOG.find((entry) => entry.id === normalized);
}

export function buildCatalogWebSearchDefaults(
  providers: InitProviderTemplate[]
): { routeTargets: string[]; webSearch: Record<string, unknown> } | null {
  const bindings = providers
    .map((provider) => ({ provider, binding: provider.webSearch }))
    .filter((entry): entry is { provider: InitProviderTemplate; binding: ProviderCatalogWebSearchBinding } => Boolean(entry.binding));

  if (!bindings.length) {
    return null;
  }

  const defaultEngineId = bindings.find((entry) => entry.binding.default)?.binding.engineId ?? bindings[0].binding.engineId;
  const routeTargets = dedupeTargets(
    bindings.map(({ provider, binding }) => binding.routeTarget || binding.providerKey || `${provider.id}.${binding.modelId || provider.defaultModel}`)
  );

  const engines = bindings.map(({ provider, binding }) => ({
    id: binding.engineId,
    providerKey: binding.providerKey || `${provider.id}.${binding.modelId || provider.defaultModel}`,
    ...(binding.modelId ? { modelId: binding.modelId } : {}),
    description: binding.description,
    executionMode: binding.executionMode,
    ...(binding.directActivation ? { directActivation: binding.directActivation } : {}),
    ...(binding.engineId === defaultEngineId ? { default: true } : {})
  }));

  const search = Object.fromEntries(
    bindings.map(({ provider, binding }) => [
      binding.engineId,
      {
        providerKey: binding.providerKey || `${provider.id}.${binding.modelId || provider.defaultModel}`
      }
    ])
  );

  return {
    routeTargets,
    webSearch: {
      engines,
      search
    }
  };
}

export function buildCatalogMultimodalTargets(
  providers: InitProviderTemplate[]
): string[] {
  return dedupeTargets(
    providers
      .map((provider) => provider.multimodalRouteTarget)
      .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
  );
}
