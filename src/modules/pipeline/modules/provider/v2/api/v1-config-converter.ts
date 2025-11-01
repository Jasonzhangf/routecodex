/**
 * V1 Config Converter - V1配置转换器
 *
 * 将V1版本的Provider配置转换为V2版本的OpenAIStandard配置
 */

import type { OpenAIStandardConfig } from './provider-config.js';
import type { IProviderV2, ProviderType } from './provider-types.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { ModuleConfig } from '../../../../interfaces/pipeline-interfaces.js';

// 临时ProviderConfig类型定义
interface ProviderConfig {
  baseUrl?: string;
  auth?: {
    type: 'apikey' | 'oauth';
    apiKey?: string;
    token?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    authUrl?: string;
    redirectUri?: string;
    scope?: string;
    headerName?: string;
    prefix?: string;
  };
}

/**
 * V1配置转换器
 *
 * 提供V1到V2的配置转换功能
 */
export class V1ConfigConverter {
  /**
   * 将V1 ModuleConfig转换为V2 OpenAIStandardConfig
   */
  static fromV1Config(v1Config: ModuleConfig): OpenAIStandardConfig {
    const providerConfig = v1Config.config as ProviderConfig;

    // 确定provider类型
    const providerType = this.extractProviderType(v1Config, providerConfig);

    // 转换认证配置
    const auth = this.convertAuthConfig(providerConfig);

    // 构建V2配置
    const v2Config: OpenAIStandardConfig = {
      type: 'openai-standard',
      config: {
        providerType,
        auth,
        // 保留V1配置中的覆盖设置
        ...(providerConfig.baseUrl && { baseUrl: providerConfig.baseUrl }),
        ...((v1Config as any).overrides && { overrides: this.convertOverrides((v1Config as any).overrides) })
      }
    };

    return v2Config;
  }

  /**
   * 从V1配置提取provider类型
   */
  private static extractProviderType(v1Config: ModuleConfig, providerConfig: any): ProviderType {
    // 1. 从provider type推断
    if (v1Config.type && typeof v1Config.type === 'string') {
      const typeMap: Record<string, string> = {
        'glm-http-provider': 'glm',
        'qwen-provider': 'qwen',
        'iflow-provider': 'iflow',
        'lmstudio-provider-simple': 'lmstudio',
        'openai-provider': 'openai',
        'generic-openai-provider': 'openai'
      };

      const mappedType = typeMap[v1Config.type];
      if (mappedType) {
        return mappedType as ProviderType;
      }
    }

    // 2. 从base URL推断
    if (providerConfig.baseUrl) {
      const urlMap: Record<string, string> = {
        'open.bigmodel.cn': 'glm',
        'portal.qwen.ai': 'qwen',
        'api.iflow.ai': 'iflow',
        'api.openai.com': 'openai'
      };

      for (const [domain, type] of Object.entries(urlMap)) {
        if (providerConfig.baseUrl!.includes(domain)) {
          return type as ProviderType;
        }
      }
    }

    // 3. 从默认配置推断
    if (providerConfig.auth?.type === 'oauth') {
      // Qwen使用OAuth
      return 'qwen' as ProviderType;
    } else if (providerConfig.auth?.type === 'apikey') {
      // 默认假设为GLM
      return 'glm' as ProviderType;
    }

    // 4. 默认为openai
    return 'openai' as ProviderType;
  }

  /**
   * 转换认证配置
   */
  private static convertAuthConfig(providerConfig: any): any {
    const auth = providerConfig.auth;

    if (!auth) {
      throw new Error('V1 config missing authentication configuration');
    }

    if (auth.type === 'apikey') {
      return {
        type: 'apikey',
        apiKey: auth.apiKey || auth.token,
        ...(auth.headerName && { headerName: auth.headerName }),
        ...(auth.prefix && { prefix: auth.prefix })
      };
    } else if (auth.type === 'oauth') {
      return {
        type: 'oauth',
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        tokenUrl: auth.tokenUrl,
        authUrl: auth.authUrl,
        redirectUri: auth.redirectUri,
        scope: auth.scope,
        grantType: auth.grantType || 'authorization_code'
      };
    }

    throw new Error(`Unsupported auth type in V1 config: ${(auth as any).type}`);
  }

  /**
   * 转换覆盖配置
   */
  private static convertOverrides(v1Overrides: any): any {
    const overrides: any = {};

    // 转换模型覆盖
    if (v1Overrides.model) {
      overrides.defaultModel = v1Overrides.model;
    }

    // 转换基础URL覆盖
    if (v1Overrides.baseUrl) {
      overrides.baseUrl = v1Overrides.baseUrl;
    }

    // 转换端点覆盖
    if (v1Overrides.endpoint) {
      overrides.endpoint = v1Overrides.endpoint;
    }

    // 转换头部覆盖
    if (v1Overrides.headers) {
      overrides.headers = v1Overrides.headers;
    }

    // 转换超时设置
    if (v1Overrides.timeout) {
      overrides.timeout = v1Overrides.timeout;
    }

    // 转换重试设置
    if (v1Overrides.maxRetries) {
      overrides.maxRetries = v1Overrides.maxRetries;
    }

    return overrides;
  }

  /**
   * 创建V2 Provider实例从V1配置
   */
  static async createV2ProviderFromV1(
    v1Config: ModuleConfig,
    dependencies: ModuleDependencies
  ): Promise<IProviderV2> {
    const { createOpenAIStandard } = await import('../core/provider-factory.js');

    // 转换配置
    const v2Config = this.fromV1Config(v1Config);

    // 创建V2实例
    const provider = createOpenAIStandard(v2Config, dependencies);

    // 初始化provider
    await provider.initialize();

    return provider;
  }

  /**
   * 批量转换V1配置到V2
   */
  static convertV1Configs(v1Configs: ModuleConfig[]): OpenAIStandardConfig[] {
    return v1Configs.map(config => this.fromV1Config(config));
  }

  /**
   * 验证V1配置是否可以转换
   */
  static validateV1Config(v1Config: ModuleConfig): {
    canConvert: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查必需字段
    if (!v1Config.config) {
      errors.push('Missing required field: config');
    }

    const providerConfig = v1Config.config as any;
    if (!providerConfig.auth) {
      errors.push('Missing required field: config.auth');
    }

    // 检查认证配置
    if (providerConfig.auth) {
      const auth = providerConfig.auth;
      if (auth.type === 'apikey' && !auth.apiKey && !auth.token) {
        errors.push('Missing API key in V1 config');
      }

      if (auth.type === 'oauth' && !auth.clientId) {
        errors.push('Missing client ID in OAuth config');
      }
    }

    // 检查provider类型识别
    const providerType = this.extractProviderType(v1Config, providerConfig);
    if (!['openai', 'glm', 'qwen', 'iflow', 'lmstudio'].includes(providerType)) {
      warnings.push(`Unrecognized provider type: ${providerType}, defaulting to openai`);
    }

    return {
      canConvert: errors.length === 0,
      errors,
      warnings
    };
  }
}

/**
 * 便捷函数：从V1配置创建V2 Provider
 */
export async function fromV1Config(
  v1Config: ModuleConfig,
  dependencies: ModuleDependencies
): Promise<IProviderV2> {
  return V1ConfigConverter.createV2ProviderFromV1(v1Config, dependencies);
}

export default V1ConfigConverter;