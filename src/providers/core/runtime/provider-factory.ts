/**
 * Provider Factory - Provider实例创建工厂
 *
 * 提供统一的Provider实例创建和管理功能
 */

import type { ProviderConfigInternal } from './http-transport-provider.js';

import crypto from 'node:crypto';
import { PROVIDER_CACHE } from '../../../constants/index.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { IProviderV2, ProviderRuntimeProfile } from '../api/provider-types.js';
import {
  normalizeProviderFamily,
  normalizeProviderType,
  providerTypeToProtocol
} from '../utils/provider-type-utils.js';
import {
  isDeepSeekRuntimeIdentity,
  readDeepSeekProviderRuntimeOptions
} from '../contracts/deepseek-provider-contract.js';
import {
  getAuthSignature,
  instantiateProvider,
  mapProviderModule,
  mapRuntimeAuthToConfig,
  mapRuntimeResponsesConfig,
  resolveProviderModule,
  type RuntimeFactoryAuthConfig
} from './provider-factory-helpers.js';

type RuntimeAwareProvider = IProviderV2 & { setRuntimeProfile?: (runtime: ProviderRuntimeProfile) => void };
type RuntimeAwareConfig = OpenAIStandardConfig['config'] & { runtimeKey?: string };

/**
 * Provider工厂类
 *
 * 负责创建和管理Provider实例
 */
export class ProviderFactory {
  // 使用 LRU 缓存，避免无界内存增长
  // 每个 router 配置的 provider 只缓存一个实例
  private static instances = new Map<string, IProviderV2>();
  // LRU 访问顺序跟踪
  private static instanceAccessOrder: string[] = [];

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
      // 更新 LRU 顺序
      this.touchInstance(instanceId);
      return this.instances.get(instanceId)!;
    }

    // 检查缓存上限，执行 LRU 淘汰
    this.evictIfNeeded();

    const providerType = normalizeProviderType(config?.config?.providerType);
    const moduleType = String(config?.type || '').toLowerCase();

    const provider = instantiateProvider(providerType, moduleType, config, dependencies);
    if (runtime) {
      this.applyRuntimeProfile(provider, runtime);
    }

    this.instances.set(instanceId, provider);
    this.instanceAccessOrder.push(instanceId);

    return provider;
  }

  /**
   * 更新实例访问顺序 (LRU)
   */
  private static touchInstance(instanceId: string): void {
    const index = this.instanceAccessOrder.indexOf(instanceId);
    if (index > -1) {
      this.instanceAccessOrder.splice(index, 1);
    }
    this.instanceAccessOrder.push(instanceId);
  }

  /**
   * LRU 淘汰：当缓存超过上限时，清理最久未使用的实例
   */
  private static evictIfNeeded(): void {
    if (this.instances.size < PROVIDER_CACHE.MAX_INSTANCES) {
      return;
    }

    // 计算需要淘汰的数量 (清理 10%)
    const evictCount = Math.max(1, Math.floor(PROVIDER_CACHE.MAX_INSTANCES * 0.1));
    const toEvict: string[] = [];

    for (let i = 0; i < this.instanceAccessOrder.length && toEvict.length < evictCount; i++) {
      const id = this.instanceAccessOrder[i];
      toEvict.push(id);
    }

    for (const id of toEvict) {
      const provider = this.instances.get(id);
      if (provider) {
        // 异步清理，不阻塞创建流程
        provider.cleanup().catch(() => {
          // 忽略清理错误
        });
      }
      this.instances.delete(id);
    }

    // 移除已淘汰的 ID
    this.instanceAccessOrder = this.instanceAccessOrder.filter(id => !toEvict.includes(id));
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
    this.instanceAccessOrder = [];
  }

  /**
   * 清理实例缓存（不重复触发 provider.cleanup）
   */
  static clearInstanceCache(): void {
    this.instances.clear();
    this.instanceAccessOrder = [];
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
    const authSignature = auth ? getAuthSignature(auth) : '';
    const input = `${providerType}:${baseUrl}:${authType}:${authSignature}`;
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, PROVIDER_CACHE.INSTANCE_ID_HASH_LENGTH);
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
    const authConfig = mapRuntimeAuthToConfig(runtime.auth, runtime.runtimeKey, runtime);
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
    const deepseekOptions = readDeepSeekProviderRuntimeOptions({
      runtimeOptions: runtime.deepseek,
      extensions: (runtime as unknown as { extensions?: Record<string, unknown> }).extensions,
      metadata: (runtime as unknown as { metadata?: Record<string, unknown> }).metadata
    });
    if (
      deepseekOptions &&
      isDeepSeekRuntimeIdentity({
        providerFamily,
        providerId: runtime.providerId,
        providerKey: runtime.providerKey,
        compatibilityProfile: runtime.compatibilityProfile
      })
    ) {
      extensions.deepseek = deepseekOptions;
    }
    extensions.providerProtocol = runtime.providerProtocol || providerTypeToProtocol(providerType);
    const moduleOverride =
      resolveProviderModule(runtime.providerModule) ??
      this.resolveImplicitProviderModule(runtime, authConfig);

    const timeoutMs =
      typeof runtime.timeoutMs === 'number' && Number.isFinite(runtime.timeoutMs) && runtime.timeoutMs > 0
        ? Math.floor(runtime.timeoutMs)
        : undefined;
    const maxRetries =
      typeof runtime.maxRetries === 'number' && Number.isFinite(runtime.maxRetries) && runtime.maxRetries >= 0
        ? Math.floor(runtime.maxRetries)
        : undefined;

    const configNode: ProviderConfigInternal = {
      providerType,
      providerId: providerFamily,
      baseUrl,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      auth: authConfig,
      overrides,
      ...(Object.keys(extensions).length ? { extensions } : {})
    };
    const responsesConfig = mapRuntimeResponsesConfig(runtime.responsesConfig, runtime.streaming);
    if (responsesConfig) {
      configNode.responses = responsesConfig;
    }
    return {
      type: moduleOverride ?? mapProviderModule(providerType),
      config: configNode
    };
  }

  private static resolveImplicitProviderModule(
    runtime: ProviderRuntimeProfile,
    authConfig: RuntimeFactoryAuthConfig
  ): OpenAIStandardConfig['type'] | undefined {
    const authRawType =
      typeof (authConfig as { rawType?: unknown }).rawType === 'string'
        ? String((authConfig as { rawType?: string }).rawType).trim().toLowerCase()
        : '';

    if (authRawType === 'deepseek-account') {
      return 'deepseek-http-provider';
    }

    if (
      isDeepSeekRuntimeIdentity({
        providerFamily: runtime.providerFamily,
        providerId: runtime.providerId,
        providerKey: runtime.providerKey,
        compatibilityProfile: runtime.compatibilityProfile
      })
    ) {
      return 'deepseek-http-provider';
    }

    return undefined;
  }

  private static applyRuntimeProfile(provider: IProviderV2, runtime: ProviderRuntimeProfile): void {
    const candidate = provider as RuntimeAwareProvider;
    if (typeof candidate.setRuntimeProfile === 'function') {
      candidate.setRuntimeProfile(runtime);
    }
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
