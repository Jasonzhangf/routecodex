/**
 * Provider Factory - Provider实例创建工厂
 *
 * 提供统一的Provider实例创建和管理功能
 */

import { OpenAIHttpProvider } from './openai-http-provider.js';
import { ResponsesHttpProvider } from './responses-http-provider.js';
import { AnthropicHttpProvider } from './anthropic-http-provider.js';
import { iFlowHttpProvider } from './iflow-http-provider.js';
import { ChatHttpProvider } from './chat-http-provider.js';
import { GeminiHttpProvider } from './gemini-http-provider.js';
import { MockProvider } from '../../mock/index.js';
import { GeminiCLIHttpProvider } from './gemini-cli-http-provider.js';
import type { ProviderConfigInternal } from './http-transport-provider.js';

import crypto from 'node:crypto';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { OpenAIStandardConfig, ApiKeyAuth, OAuthAuth, OAuthAuthType } from '../api/provider-config.js';
import type { IProviderV2, ProviderRuntimeProfile, ProviderRuntimeAuth, ProviderType } from '../api/provider-types.js';import {
  normalizeProviderFamily,
  normalizeProviderType,
  providerTypeToProtocol
} from '../utils/provider-type-utils.js';

type RuntimeAwareProvider = IProviderV2 & {
  setRuntimeProfile?: (runtime: ProviderRuntimeProfile) => void;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
type RuntimeAwareConfig = OpenAIStandardConfig['config'] & { runtimeKey?: string }; 
type ApiKeyAuthExtended = ApiKeyAuth & { secretRef?: string };
type OAuthAuthExtended = OAuthAuth & { oauthProviderId?: string };

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

    if (this.instances.has(instanceId)) {
      return this.instances.get(instanceId)!;
    }

    const providerType = normalizeProviderType(config?.config?.providerType);
    const moduleType = String(config?.type || '').toLowerCase();

    const provider = this.instantiateProvider(providerType, moduleType, config, dependencies);
    if (runtime) {
      this.applyRuntimeProfile(provider, runtime);
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
    const runtimeConfig = config?.config as RuntimeAwareConfig;
    const configRuntimeKey = runtimeConfig?.runtimeKey;
    if (runtime?.runtimeKey) {
      return runtime.runtimeKey;
    }
    if (typeof configRuntimeKey === 'string' && configRuntimeKey.trim()) {
      return configRuntimeKey.trim();
    }
    const providerType = config?.config?.providerType || 'unknown';
    const baseUrl = config?.config?.baseUrl || '';
    const auth = config?.config?.auth;
    const authType = String(auth?.type || '').toLowerCase();
    const authSignature = auth ? this.getAuthSignature(auth) : '';
    const input = `${providerType}:${baseUrl}:${authType}:${authSignature}`;
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  private static buildConfigFromRuntime(runtime: ProviderRuntimeProfile): OpenAIStandardConfig {
    const baseUrl = (runtime.baseUrl || runtime.endpoint || '').trim();
    if (!baseUrl || !baseUrl.trim()) {
      throw new Error(`[ProviderFactory] runtime ${runtime.runtimeKey} missing baseUrl`);
    }
    const providerType = normalizeProviderType(runtime.providerType);
    const providerFamily = normalizeProviderFamily(
      runtime.providerFamily,
      runtime.providerId,
      runtime.providerKey,
      providerType
    );
    const authConfig = this.mapRuntimeAuthToConfig(runtime.auth, runtime.runtimeKey, runtime);
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
    extensions.providerProtocol = runtime.providerProtocol || providerTypeToProtocol(providerType);
    const moduleOverride = this.resolveProviderModule(runtime.providerModule);
    const configNode: ProviderConfigInternal = {
      providerType,
      providerId: providerFamily,
      baseUrl,
      auth: authConfig,
      overrides,
      ...(Object.keys(extensions).length ? { extensions } : {})
    };
    const responsesConfig = this.mapRuntimeResponsesConfig(runtime.responsesConfig, runtime.streaming);
    if (responsesConfig) {
      configNode.responses = responsesConfig;
    }
    return {
      type: moduleOverride ?? this.mapProviderModule(providerType),
      config: configNode
    };
  }

  private static mapRuntimeResponsesConfig(
    source: unknown,
    streamingPref?: 'auto' | 'always' | 'never'
  ): Record<string, unknown> | undefined {
    if (!source && !streamingPref) {
      return undefined;
    }
    const node = (source && typeof source === 'object' ? (source as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const responses: Record<string, unknown> = {};
    if (typeof node.toolCallIdStyle === 'string') {
      responses.toolCallIdStyle = node.toolCallIdStyle;
    }
    const streamingValue =
      node.streaming !== undefined && node.streaming !== null ? node.streaming : streamingPref;
    if (typeof streamingValue === 'string') {
      responses.streaming = streamingValue;
    } else if (streamingValue === true) {
      responses.streaming = 'always';
    } else if (streamingValue === false) {
      responses.streaming = 'never';
    }
    if (typeof node.instructionsMode === 'string') {
      responses.instructionsMode = node.instructionsMode;
    }
    return Object.keys(responses).length ? responses : undefined;
  }

  private static isLocalBaseUrl(value?: string): boolean {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
      return false;
    }
    try {
      const url = new URL(raw);
      const host = String(url.hostname || '').trim().toLowerCase();
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host === '::1' ||
        host === '::ffff:127.0.0.1'
      );
    } catch {
      const lower = raw.toLowerCase();
      return (
        lower.includes('localhost') ||
        lower.includes('127.0.0.1') ||
        lower.includes('0.0.0.0') ||
        lower.includes('[::1]')
      );
    }
  }

  private static mapRuntimeAuthToConfig(auth: ProviderRuntimeAuth, runtimeKey: string, runtime?: ProviderRuntimeProfile) {
    if (auth.type === 'apikey') {
      if (!isNonEmptyString(auth.value)) {
        const baseUrl =
          runtime && typeof (runtime as any).baseUrl === 'string'
            ? String((runtime as any).baseUrl).trim()
            : runtime && typeof (runtime as any).endpoint === 'string'
              ? String((runtime as any).endpoint).trim()
              : '';
        if (this.isLocalBaseUrl(baseUrl)) {
          return { type: 'apikey', apiKey: '' } as ApiKeyAuth;
        }
        throw new Error(`[ProviderFactory] runtime ${runtimeKey} missing inline apiKey value`);
      }
      const apiKeyAuth: ApiKeyAuth = {
        type: 'apikey',
        apiKey: auth.value.trim()
      };
      return apiKeyAuth;
    }

    const oauthType: OAuthAuthType = isNonEmptyString(auth.rawType)
      ? (auth.rawType.trim() as OAuthAuthType)
      : 'oauth';

    const oauthAuth: OAuthAuthExtended = {
      type: oauthType,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      scopes: auth.scopes,
      tokenFile: auth.tokenFile,
      tokenUrl: auth.tokenUrl,
      deviceCodeUrl: auth.deviceCodeUrl,
      authorizationUrl: auth.authorizationUrl,
      userInfoUrl: auth.userInfoUrl,
      refreshUrl: auth.refreshUrl
    };

    if (auth.oauthProviderId) {
      oauthAuth.oauthProviderId = auth.oauthProviderId;
    }

    return oauthAuth;
  }

  private static resolveProviderModule(value?: string): OpenAIStandardConfig['type'] | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    switch (trimmed) {
      case 'openai-standard':
      case 'openai-http-provider':
      case 'responses-http-provider':
      case 'anthropic-http-provider':
      case 'gemini-http-provider':
      case 'gemini-cli-http-provider':
      case 'mock-provider':
        return trimmed as OpenAIStandardConfig['type'];
      default:
        return undefined;
    }
  }

  private static mapProviderModule(
    providerType: ProviderType
  ): OpenAIStandardConfig['type'] {
    if (providerType === 'responses') {
      return 'responses-http-provider';
    }
    if (providerType === 'anthropic') {
      return 'anthropic-http-provider';
    }
    if (providerType === 'gemini') {
      // 默认返回标准 gemini-http-provider，但允许 config 显式指定 gemini-cli-http-provider
      return 'gemini-http-provider';
    }
    if (providerType === 'mock') {
      return 'mock-provider';
    }
    return 'openai-http-provider';
  }

  private static instantiateProvider(
    providerType: ProviderType,
    moduleType: string,
    config: OpenAIStandardConfig,
    dependencies: ModuleDependencies
  ): IProviderV2 {
    if (moduleType === 'mock-provider') {
      return new MockProvider(config, dependencies);
    }
    if (moduleType === 'gemini-cli-http-provider') {
      return new GeminiCLIHttpProvider(config, dependencies);
    }
    if (moduleType === 'gemini-http-provider') {
      return new GeminiHttpProvider(config, dependencies);
    }

    switch (providerType) {
      case 'openai':
        return new ChatHttpProvider(config, dependencies);
      case 'responses':
        return new ResponsesHttpProvider(config, dependencies);
      case 'anthropic':
        return new AnthropicHttpProvider(config, dependencies);
      case 'gemini':
        {
          // Check if OAuth type is gemini-cli-oauth to decide between providers
          const oauthType = config?.config?.auth?.type;
          if (oauthType === 'gemini-cli-oauth') {
            return new GeminiCLIHttpProvider(config, dependencies);
          }
          return new GeminiHttpProvider(config, dependencies);
        }
      default:
        break;
    }

    if (moduleType === 'openai-http-provider' || moduleType === 'openai-standard') {
      return new OpenAIHttpProvider(config, dependencies);
    }
    if (moduleType === 'responses-http-provider') {
      return new ResponsesHttpProvider(config, dependencies);
    }
    if (moduleType === 'anthropic-http-provider') {
      return new AnthropicHttpProvider(config, dependencies);
    }
    if (moduleType === 'iflow-http-provider') {
      return new iFlowHttpProvider(config, dependencies);
    }
    const error = new Error(`[ProviderFactory] Unsupported providerType='${providerType}' and moduleType='${moduleType}'`);
    (error as Error & { code?: string }).code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
    throw error;
  }

  private static applyRuntimeProfile(provider: IProviderV2, runtime: ProviderRuntimeProfile): void {
    const candidate = provider as RuntimeAwareProvider;
    if (typeof candidate.setRuntimeProfile === 'function') {
      candidate.setRuntimeProfile(runtime);
    }
  }

  private static getAuthSignature(auth: ApiKeyAuth | OAuthAuth): string {
    if (auth.type === 'apikey') {
      const apiKeyAuth = auth as ApiKeyAuthExtended;
      if (isNonEmptyString(apiKeyAuth.secretRef)) {
        return apiKeyAuth.secretRef.trim();
      }
      return apiKeyAuth.apiKey.trim();
    }

    const tokenFile = isNonEmptyString(auth.tokenFile) ? auth.tokenFile.trim() : '';
    if (tokenFile) {
      return tokenFile;
    }
    if (isNonEmptyString(auth.clientId)) {
      return auth.clientId.trim();
    }
    if (isNonEmptyString(auth.authorizationUrl)) {
      return auth.authorizationUrl.trim();
    }
    return auth.type;
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
