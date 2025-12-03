/**
 * Provider Factory - Provider实例创建工厂
 *
 * 提供统一的Provider实例创建和管理功能
 */

import { ResponsesProvider } from './responses-provider.js';
import { OpenAIHttpProvider } from './openai-http-provider.js';
import { ResponsesHttpProvider } from './responses-http-provider.js';
import { AnthropicHttpProvider } from './anthropic-http-provider.js';
import { iFlowHttpProvider } from './iflow-http-provider.js';
import { ChatHttpProvider } from './chat-http-provider.js';
import { GeminiHttpProvider } from './gemini-http-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import crypto from 'node:crypto';
import type { IProviderV2, ProviderRuntimeProfile, ProviderRuntimeAuth } from '../api/provider-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';

/**
 * Provider工厂类
 *
 * 负责创建和管理Provider实例
 */
export class ProviderFactory {
  private static instances = new Map<string, IProviderV2>();

  /**
   * 创建Provider实例
   */
  static createProvider(
    config: OpenAIStandardConfig,
    dependencies: ModuleDependencies,
    runtime?: ProviderRuntimeProfile
  ): IProviderV2 {
    return this.createProviderInternal(config, dependencies, runtime);
  }

  /**
   * 通过 runtime profile 创建 Provider 实例
   */
  static createProviderFromRuntime(
    runtime: ProviderRuntimeProfile,
    dependencies: ModuleDependencies
  ): IProviderV2 {
    const config = this.buildConfigFromRuntime(runtime);
    return this.createProviderInternal(config, dependencies, runtime);
  }

  private static createProviderInternal(
    config: OpenAIStandardConfig,
    dependencies: ModuleDependencies,
    runtime?: ProviderRuntimeProfile
  ): IProviderV2 {
    const instanceId = this.generateInstanceId(config, runtime);

    // 检查是否已存在实例
    if (this.instances.has(instanceId)) {
      return this.instances.get(instanceId)!;
    }

    // 创建新实例
    const rawType = String(config?.config?.providerType || '').toLowerCase();
    const moduleType = String(config?.type || '').toLowerCase();
    const ptype = rawType as string;

    let provider: IProviderV2;

    // 首选：按协议类型创建
    const chatProviderTypes = new Set(['openai', 'glm', 'qwen', 'lmstudio']);
    if (chatProviderTypes.has(ptype)) {
      provider = new ChatHttpProvider(config, dependencies);
    } else if (ptype === 'responses') {
      provider = new ResponsesHttpProvider(config, dependencies);
    } else if (ptype === 'anthropic') {
      provider = new AnthropicHttpProvider(config, dependencies);
    } else if (ptype === 'gemini') {
      provider = new GeminiHttpProvider(config, dependencies);
    } else if (ptype === 'iflow') {
      provider = new iFlowHttpProvider(config, dependencies);
    } else {
      // 兼容保留：模块类型直选（老配置）；不再做“最终回退”，未知类型直接失败（Fail Fast）
      if (moduleType === 'openai-http-provider' || moduleType === 'openai-standard') {
        provider = new OpenAIHttpProvider(config, dependencies);
      } else if (moduleType === 'responses-http-provider') {
        provider = new ResponsesHttpProvider(config, dependencies);
      } else if (moduleType === 'anthropic-http-provider') {
        provider = new AnthropicHttpProvider(config, dependencies);
      } else {
        const err: any = new Error(`[ProviderFactory] Unsupported providerType='${ptype}' and moduleType='${moduleType}'`);
        err.code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
        throw err;
      }
    }
    if (provider && typeof (provider as any).setRuntimeProfile === 'function' && runtime) {
      (provider as any).setRuntimeProfile(runtime);
    }

    this.instances.set(instanceId, provider);

    return provider;
  }

  /**
   * 获取现有Provider实例
   */
  static getProvider(config: OpenAIStandardConfig, runtime?: ProviderRuntimeProfile): IProviderV2 | null {
    const instanceId = this.generateInstanceId(config, runtime);
    return this.instances.get(instanceId) || null;
  }

  /**
   * 清理所有Provider实例
   */
  static async cleanupAll(): Promise<void> {
    const cleanupPromises = Array.from(this.instances.values()).map(provider =>
      provider.cleanup().catch(error => {
        console.error('Error cleaning up provider:', error);
      })
    );

    await Promise.all(cleanupPromises);
    this.instances.clear();
  }

  /**
   * 获取所有活跃实例
   */
  static getActiveInstances(): Map<string, IProviderV2> {
    return new Map(this.instances);
  }

  /**
   * 验证配置
   */
  static validateConfig(config: OpenAIStandardConfig): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查必需字段
    if (!config?.config?.providerType) {
      errors.push('providerType is required');
    }

    if (!config?.config?.auth?.type) {
      errors.push('auth.type is required');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * 生成实例ID
   */
  private static generateInstanceId(config: OpenAIStandardConfig, runtime?: ProviderRuntimeProfile): string {
    const configRuntimeKey = (config?.config as any)?.runtimeKey;
    if (runtime?.runtimeKey) {
      return runtime.runtimeKey;
    }
    if (typeof configRuntimeKey === 'string' && configRuntimeKey.trim()) {
      return configRuntimeKey.trim();
    }
    const providerType = config?.config?.providerType || 'unknown';
    const baseUrl = config?.config?.baseUrl || '';
    const authType = String(config?.config?.auth?.type || '').toLowerCase();
    const authSignature =
      authType === 'apikey'
        ? ((config.config.auth as any)?.secretRef || '')
        : ((config.config.auth as any)?.tokenFile || '');
    const input = `${providerType}:${baseUrl}:${authType}:${authSignature}`;
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  private static buildConfigFromRuntime(runtime: ProviderRuntimeProfile): OpenAIStandardConfig {
    const baseUrl = (runtime.baseUrl || runtime.endpoint || '').trim();
    if (!baseUrl || !baseUrl.trim()) {
      throw new Error(`[ProviderFactory] runtime ${runtime.runtimeKey} missing baseUrl`);
    }
    const authConfig = this.mapRuntimeAuthToConfig(runtime.auth, runtime.runtimeKey);
    const endpointOverride =
      runtime.endpoint && !/^https?:\/\//i.test(runtime.endpoint.trim())
        ? runtime.endpoint.trim()
        : undefined;
    const overrides: Record<string, unknown> = {
      defaultModel: runtime.defaultModel,
      headers: runtime.headers,
      ...(endpointOverride ? { endpoint: endpointOverride } : {})
    };
    const extensions: Record<string, unknown> = {};
    if (runtime.auth?.oauthProviderId) {
      extensions.oauthProviderId = runtime.auth.oauthProviderId;
    }
    return {
      type: this.mapProviderModule(runtime.providerType),
      config: {
        providerType: runtime.providerType,
        baseUrl,
        auth: authConfig,
        overrides,
        ...(Object.keys(extensions).length ? { extensions } : {})
      }
    };
  }

  private static mapRuntimeAuthToConfig(auth: ProviderRuntimeAuth, runtimeKey: string) {
    if (auth.type === 'apikey') {
      if (!auth.value || !auth.value.trim()) {
        throw new Error(`[ProviderFactory] runtime ${runtimeKey} missing inline apiKey value`);
      }
      return {
        type: 'apikey' as const,
        apiKey: auth.value.trim()
      };
    }
    const authType = typeof auth.rawType === 'string' && auth.rawType.trim()
      ? auth.rawType.trim()
      : 'oauth';
    return {
      type: authType as any,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      scopes: auth.scopes,
      tokenFile: auth.tokenFile,
      tokenUrl: auth.tokenUrl,
      deviceCodeUrl: auth.deviceCodeUrl,
      authorizationUrl: auth.authorizationUrl,
      userInfoUrl: auth.userInfoUrl,
      refreshUrl: auth.refreshUrl,
      oauthProviderId: auth.oauthProviderId,
      rawType: auth.rawType
    };
  }

  private static mapProviderModule(
    providerType: string
  ): OpenAIStandardConfig['type'] {
    const normalized = (providerType || '').toLowerCase();
    if (normalized === 'responses') return 'responses-http-provider';
    if (normalized === 'anthropic') return 'anthropic-http-provider';
    if (normalized === 'gemini') return 'gemini-http-provider';
    if (normalized === 'iflow') return 'iflow-http-provider';
    return 'openai-http-provider';
  }
}

/**
 * 便捷函数 - 创建Provider实例
 */
export function createChatHttpProvider(
  config: OpenAIStandardConfig,
  dependencies: ModuleDependencies
): IProviderV2 {
  return ProviderFactory.createProvider(config, dependencies);
}

/**
 * 便捷函数 - 从V1配置转换
 */
export function fromV1Config(_v1Config: unknown, _dependencies: ModuleDependencies): IProviderV2 {
  // 这里会实现V1到V2的配置转换
  // 实际实现在api/config-provider.ts中
  throw new Error('V1 config transformation not implemented yet');
}
