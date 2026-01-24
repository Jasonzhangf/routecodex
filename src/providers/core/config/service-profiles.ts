/**
 * Service Profiles - 服务预设配置
 *
 * 定义各个OpenAI兼容服务的预设配置档案
 */
import os from 'node:os';
import { API_ENDPOINTS, API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS, DEFAULT_CONFIG } from "../../../constants/index.js";
import type { ServiceProfile } from '../api/provider-types.js';

/**
 * 解析 Gemini UA 并返回合适的 User-Agent。
 *
 * 为了与 gcli2api 保持一致，这里直接采用 GeminiCLI 伪装 UA，
 * 不再通过环境变量进行运行时切换，避免行为复杂化。
 */
function resolveGeminiCliUserAgent(): string {
  // 对齐 gcli2api：GeminiCLI/<version> (<system>; <arch>)
  // 版本号采用保守的固定值，避免频繁变更 UA 指纹。
  const version = '0.1.5';
  const systemRaw = os.type();
  const arch = os.arch();
  // 轻量规范化 system 文本，使其更接近 Python platform.system() 的输出。
  let system = systemRaw;
  if (systemRaw === 'Darwin') {
    system = 'Mac OS';
  } else if (systemRaw === 'Windows_NT') {
    system = 'Windows';
  }
  return `GeminiCLI/${version} (${system}; ${arch})`;
}

/**
 * 动态服务配置档案构建器
 *
 * 每个OpenAI兼容服务的基础配置，特殊处理通过动态配置注入
 */
export const BASE_SERVICE_PROFILES: Record<string, Omit<ServiceProfile, 'hooks' | 'extensions'>> = {
  /**
   * OpenAI Responses API (native Responses endpoint)
   * - Used for true SSE passthrough on /v1/responses
   * - Auth: apikey (sk-...)
   */
  responses: {
    defaultBaseUrl: API_ENDPOINTS.OPENAI,
    defaultEndpoint: '/responses',
    defaultModel: '',
    requiredAuth: ['apikey'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json',
      // Monitor成功样本要求此Beta标头，确保上游接受Responses协议
      'OpenAI-Beta': 'responses-2024-12-17'
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },
  openai: {
    defaultBaseUrl: API_ENDPOINTS.OPENAI,
    defaultEndpoint: '/chat/completions',
    defaultModel: 'gpt-4',
    requiredAuth: ['apikey'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json'
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },

  /**
   * Anthropic Messages API
   * - 标准 anthropic provider（/v1/messages）
   * - 对于 Zhipu/GLM 的 Anthropic 兼容端点，可通过 baseUrl 覆盖 defaultBaseUrl
   */
  anthropic: {
    defaultBaseUrl: API_ENDPOINTS.ANTHROPIC,
    defaultEndpoint: API_PATHS.ANTHROPIC_MESSAGES,
    defaultModel: 'claude-3-haiku-20240307',
    requiredAuth: ['apikey'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json'
      // 版本标头由上游/配置控制，这里不硬编码 anthropic-version，避免与兼容端点冲突
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },
  gemini: {
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultEndpoint: '/models:generateContent',
    defaultModel: 'models/gemini-2.0-flash',
    // gemini / gemini-cli 共享同一 providerType=gemini，只在 auth 模式上做变体
    // 允许 apikey 与 oauth，两者都视为合法
    requiredAuth: [],
    optionalAuth: ['apikey', 'oauth'],
    headers: {
      'Content-Type': 'application/json'
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },
  'gemini-cli': {
    defaultBaseUrl: 'https://cloudcode-pa.googleapis.com',
    defaultEndpoint: '/v1internal:generateContent',
    defaultModel: 'gemini-2.5-flash-lite',
    requiredAuth: ['oauth'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': resolveGeminiCliUserAgent(),
      'X-Goog-Api-Client': 'gl-node/22.17.0',
      'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },

  glm: {
    // GLM coding 路径（已验证可用）
    defaultBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    defaultEndpoint: '/chat/completions',
    defaultModel: 'glm-4',
    requiredAuth: ['apikey'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'RouteCodex/2.0'
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },

  qwen: {
    // Qwen OpenAI兼容模式
    // 对齐 CLIProxyAPI：使用 portal.qwen.ai 作为统一入口
    // OAuth 设备码/令牌端点在 chat.qwen.ai 下，由 provider-oauth-configs 提供
    defaultBaseUrl: 'https://portal.qwen.ai/v1',
    defaultEndpoint: '/chat/completions',
    // 默认模型对齐当前配置，只保留 qwen3-coder-plus
    defaultModel: 'qwen3-coder-plus',
    requiredAuth: [],
    optionalAuth: ['apikey','oauth'],
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // 对齐 CLIProxyAPI 的默认客户端标识（Qwen 官方示例）
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'X-Goog-Api-Client': 'gl-node/22.17.0',
      'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },

  iflow: {
    // 对齐最新 iflow API：apis.iflow.cn/v1
    // 避免 baseUrl 已含 /v1 时 endpoint 再次携带 /v1 导致 /v1/v1 重复
    defaultBaseUrl: 'https://apis.iflow.cn/v1',
    defaultEndpoint: '/chat/completions',
    defaultModel: 'kimi',
    requiredAuth: [],
    optionalAuth: ['oauth', 'apikey'],
    headers: {
      'Content-Type': 'application/json',
      // iFlow 对部分模型（例如 glm-4.7）会基于 UA 做强约束：
      // 必须伪装成 iFlow CLI 才能获得可用配额/能力，否则会返回 HTTP 200 + status=435 "Model not support"。
      'User-Agent': 'iFlow-Cli'
    },
    // 默认 Provider 请求超时时间：500s
    timeout: 500000,
    maxRetries: 3
  },

  lmstudio: {
    defaultBaseUrl: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.LM_STUDIO_PORT}`,
    defaultEndpoint: '/v1/chat/completions',
    defaultModel: 'local-model',
    requiredAuth: ['apikey'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json'
    },
    // LM Studio 默认请求超时时间：1000s（加倍以适配更长上下文/初始化耗时）
    timeout: 1000000,
    maxRetries: 3
  }
};

/**
 * 动态配置加载器
 */
export class DynamicProfileLoader {
  private static extensionLoaders = new Map<string, (baseProfile: Omit<ServiceProfile, 'hooks' | 'extensions'>) => Partial<ServiceProfile>>();

  /**
   * 注册provider扩展配置加载器
   */
  static registerExtensionLoader(providerType: string, loader: (baseProfile: Omit<ServiceProfile, 'hooks' | 'extensions'>) => Partial<ServiceProfile>): void {
    this.extensionLoaders.set(providerType, loader);
  }

  /**
   * 动态构建完整的服务配置
   */
  static buildServiceProfile(providerType: string): ServiceProfile | null {
    const baseProfile = BASE_SERVICE_PROFILES[providerType];
    if (!baseProfile) {
      return null;
    }

    const extensionLoader = this.extensionLoaders.get(providerType);
    const extensions = extensionLoader ? extensionLoader(baseProfile) : {};

    return {
      ...baseProfile,
      ...extensions
    } as ServiceProfile;
  }

  /**
   * 批量构建所有服务配置
   */
  static buildAllServiceProfiles(): Record<string, ServiceProfile> {
    const profiles: Record<string, ServiceProfile> = {};

    for (const providerType of Object.keys(BASE_SERVICE_PROFILES)) {
      const profile = this.buildServiceProfile(providerType);
      if (profile) {
        profiles[providerType] = profile;
      }
    }

    return profiles;
  }
}

/**
 * 兼容性：向后兼容的SERVICE_PROFILES
 * @deprecated 建议使用DynamicProfileLoader.buildServiceProfile()
 */
export const SERVICE_PROFILES: Record<string, ServiceProfile> = DynamicProfileLoader.buildAllServiceProfiles();

/**
 * 服务类型枚举
 */
export enum ServiceType {
  OPENAI = 'openai',
  GLM = 'glm',
  QWEN = 'qwen',
  IFLOW = 'iflow',
  LMSTUDIO = 'lmstudio'
}

/**
 * 服务配置验证器
 */
export class ServiceProfileValidator {
  /**
   * 验证服务配置
   */
  static validateServiceProfile(providerType: string, authType: string): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const profile = DynamicProfileLoader.buildServiceProfile(providerType);
    if (!profile) {
      errors.push(`Unknown providerType '${providerType}' (no service profile registered)`);
      return { isValid: false, errors, warnings };
    }

    // 验证认证类型
    const supportedAuthTypes = [...profile.requiredAuth, ...profile.optionalAuth];
    if (!supportedAuthTypes.includes(authType)) {
      errors.push(
        `Auth type '${authType}' not supported for provider '${providerType}'. ` +
        `Supported types: ${supportedAuthTypes.join(', ')}`
      );
    }

    // 验证必需认证
    if (profile.requiredAuth.length > 0 && !profile.requiredAuth.includes(authType)) {
      errors.push(
        `Provider '${providerType}' requires auth type: ${profile.requiredAuth.join(' or ')}`
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * 获取服务配置
   */
  static getServiceProfile(providerType: string): ServiceProfile | null {
    return DynamicProfileLoader.buildServiceProfile(providerType);
  }

  /**
   * 列出所有支持的服务类型
   */
  static getSupportedProviderTypes(): string[] {
    return Object.keys(BASE_SERVICE_PROFILES);
  }

  /**
   * 检查服务是否支持指定的认证类型
   */
  static supportsAuthType(providerType: string, authType: string): boolean {
    const profile = DynamicProfileLoader.buildServiceProfile(providerType);
    if (!profile) {
      return false;
    }

    const supportedTypes = [...profile.requiredAuth, ...profile.optionalAuth];
    return supportedTypes.includes(authType);
  }

  /**
   * 获取服务的默认配置
   */
  static getDefaultConfig(providerType: string): Partial<ServiceProfile> | null {
    const profile = DynamicProfileLoader.buildServiceProfile(providerType);
    if (!profile) {
      return null;
    }

    return {
      defaultBaseUrl: profile.defaultBaseUrl,
      defaultEndpoint: profile.defaultEndpoint,
      defaultModel: profile.defaultModel,
      headers: profile.headers,
      timeout: profile.timeout,
      maxRetries: profile.maxRetries
    };
  }
}

/**
 * 服务配置扩展接口
 *
 * 允许为特定服务添加额外的配置选项
 */
export interface ServiceProfileExtension {
  providerType: string;
  extendConfig(baseConfig: ServiceProfile): ServiceProfile;
}

/**
 * 服务配置注册器
 *
 * 允许动态注册新的服务配置
 */
export class ServiceProfileRegistry {
  private static extensions = new Map<string, ServiceProfileExtension>();

  /**
   * 注册服务配置扩展
   */
  static registerExtension(extension: ServiceProfileExtension): void {
    this.extensions.set(extension.providerType, extension);
  }

  /**
   * 获取扩展后的服务配置
   */
  static getExtendedProfile(providerType: string): ServiceProfile | null {
    const baseProfile = SERVICE_PROFILES[providerType];
    if (!baseProfile) {
      return null;
    }

    const extension = this.extensions.get(providerType);
    if (extension) {
      return extension.extendConfig(baseProfile);
    }

    return baseProfile;
  }
}

export default SERVICE_PROFILES;
