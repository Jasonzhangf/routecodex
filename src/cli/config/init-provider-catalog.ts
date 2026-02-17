export type InitProviderTemplate = {
  id: string;
  label: string;
  description: string;
  provider: Record<string, unknown>;
  defaultModel: string;
};

function apikeyAuthEnv(envVar: string) {
  return {
    type: 'apikey',
    apiKey: `\${${envVar}}`
  };
}

export function getInitProviderCatalog(): InitProviderTemplate[] {
  return [
    {
      id: 'openai',
      label: 'OpenAI (Chat)',
      description: 'OpenAI-compatible Chat API (/v1/chat/completions)',
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
              tokenFile: '~/.routecodex/auth/deepseek-account-1.json'
            }
          ]
        },
        deepseek: {
          strictToolRequired: true,
          textToolFallback: true,
          powTimeoutMs: 15000,
          powMaxAttempts: 2,
          sessionReuseTtlMs: 1800000
        },
        models: {
          'deepseek-chat': { supportsStreaming: true },
          'deepseek-reasoner': { supportsStreaming: true },
          'deepseek-chat-search': { supportsStreaming: true },
          'deepseek-reasoner-search': { supportsStreaming: true }
        }
      },
      defaultModel: 'deepseek-chat'
    },
    {
      id: 'glm',
      label: 'GLM (OpenAI-compatible)',
      description: 'Zhipu/BigModel OpenAI-compatible endpoint',
      provider: {
        id: 'glm',
        enabled: true,
        type: 'openai',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        compatibilityProfile: 'chat:glm',
        auth: apikeyAuthEnv('GLM_API_KEY'),
        models: {
          'glm-4.7': { supportsStreaming: true },
          'glm-4.6': { supportsStreaming: true }
        }
      },
      defaultModel: 'glm-4.7'
    },
    {
      id: 'glm-anthropic',
      label: 'GLM (Anthropic Messages)',
      description: 'GLM via Anthropic Messages wire (/v1/messages upstream, bridged by RouteCodex)',
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
      id: 'qwen',
      label: 'Qwen (OAuth)',
      description: 'Qwen Chat (OAuth token file), OpenAI-compatible wire',
      provider: {
        id: 'qwen',
        enabled: true,
        type: 'openai',
        baseURL: 'https://portal.qwen.ai/v1',
        compatibilityProfile: 'chat:qwen',
        auth: {
          type: 'qwen-oauth',
          tokenFile: 'default'
        },
        models: {
          'qwen3-coder-plus': { supportsStreaming: true },
          'qwen3.5-plus': { supportsStreaming: true },
          'qwen3-vl-plus': { supportsStreaming: true }
        }
      },
      defaultModel: 'qwen3-coder-plus'
    },
    {
      id: 'iflow',
      label: 'iFlow (Cookie)',
      description: 'iFlow OpenAI-compatible wire with cookie auth',
      provider: {
        id: 'iflow',
        enabled: true,
        type: 'iflow',
        baseURL: 'https://apis.iflow.cn/v1',
        compatibilityProfile: 'chat:iflow',
        auth: {
          type: 'iflow-cookie',
          cookieFile: '~/.routecodex/auth/iflow-work.cookie'
        },
        models: {
          'qwen3-coder-plus': { supportsStreaming: true },
          'qwen3-vl-plus': { supportsStreaming: true }
        }
      },
      defaultModel: 'qwen3-coder-plus'
    },
    {
      id: 'mimo',
      label: 'MiMo (OpenAI-compatible)',
      description: 'Xiaomi MiMo OpenAI-compatible endpoint',
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
    },
    {
      id: 'gemini-cli',
      label: 'Gemini CLI (Cloud Code Assist)',
      description: 'Google Cloud Code Assist v1internal endpoints (Sandbox-first)',
      provider: {
        id: 'gemini-cli',
        enabled: true,
        type: 'gemini-cli-http-provider',
        providerType: 'gemini',
        compatibilityProfile: 'chat:gemini',
        baseURL: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
        auth: {
          type: 'gemini-cli-oauth',
          entries: [
            {
              alias: 'YOUR_ALIAS_HERE',
              type: 'gemini-cli-oauth',
              tokenFile: '~/.routecodex/auth/gemini-oauth-1-YOUR_ALIAS_HERE.json'
            }
          ]
        },
        models: {
          'gemini-2.5-pro': { supportsStreaming: true },
          'gemini-2.5-flash': { supportsStreaming: true },
          'gemini-2.5-flash-lite': { supportsStreaming: true }
        }
      },
      defaultModel: 'gemini-2.5-flash'
    },
    {
      id: 'antigravity',
      label: 'Antigravity (Cloud Code Assist)',
      description: 'Antigravity/Code Assist routing via v1internal endpoints (Sandbox-first)',
      provider: {
        id: 'antigravity',
        enabled: true,
        type: 'gemini-cli-http-provider',
        providerType: 'gemini',
        compatibilityProfile: 'chat:gemini',
        baseURL: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
        auth: {
          type: 'antigravity-oauth',
          entries: [
            {
              alias: 'YOUR_ALIAS_HERE',
              type: 'antigravity-oauth',
              tokenFile: '~/.routecodex/auth/antigravity-oauth-1-YOUR_ALIAS_HERE.json'
            }
          ]
        },
        models: {
          'gemini-2.5-pro': { supportsStreaming: true },
          'gemini-2.5-flash': { supportsStreaming: true },
          'gemini-2.5-flash-lite': { supportsStreaming: true },
          'gemini-3-pro-high': { supportsStreaming: true },
          // gemini-3-pro-low has a smaller context window than the high tier.
          'gemini-3-pro-low': { supportsStreaming: true, maxContext: 256000 },
          'gemini-3-flash-preview': { supportsStreaming: true },
          'claude-sonnet-4-5': { supportsStreaming: true },
          'claude-sonnet-4-5-thinking': { supportsStreaming: true }
        }
      },
      defaultModel: 'claude-sonnet-4-5'
    }
  ];
}
