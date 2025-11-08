/**
 * Provider Factory - Provider实例创建工厂
 *
 * 提供统一的Provider实例创建和管理功能
 */

import { OpenAIStandard } from './openai-standard.js';
import { ResponsesProvider } from './responses-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { IProviderV2 } from '../api/provider-types.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';

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
  static createProvider(config: OpenAIStandardConfig, dependencies: ModuleDependencies): IProviderV2 {
    const instanceId = this.generateInstanceId(config);

    // 检查是否已存在实例
    if (this.instances.has(instanceId)) {
      return this.instances.get(instanceId)!;
    }

    // 创建新实例（按 providerType 分派）
    const ptype = String(config?.config?.providerType || '').toLowerCase();
    let provider: IProviderV2;
    if (ptype === 'responses') {
      provider = new ResponsesProvider(config, dependencies) as unknown as IProviderV2;
    } else {
      provider = new OpenAIStandard(config, dependencies);
    }
    this.instances.set(instanceId, provider);

    return provider;
  }

  /**
   * 获取现有Provider实例
   */
  static getProvider(config: OpenAIStandardConfig): IProviderV2 | null {
    const instanceId = this.generateInstanceId(config);
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

    // 验证必需字段
    if (!config.type) {
      errors.push('Missing required field: type');
    }

    if (!config.config) {
      errors.push('Missing required field: config');
    }

    if (!config.config.providerType) {
      errors.push('Missing required field: config.providerType');
    }

    if (!config.config.auth) {
      errors.push('Missing required field: config.auth');
    }

    // 验证providerType
    const supportedTypes = ['openai', 'glm', 'qwen', 'iflow', 'lmstudio', 'responses'];
    if (config.config.providerType && !supportedTypes.includes(config.config.providerType)) {
      errors.push(`Unsupported providerType: ${config.config.providerType}. Supported types: ${supportedTypes.join(', ')}`);
    }

    // 验证认证配置
    if (config.config.auth) {
      const auth = config.config.auth;
      if (auth.type === 'apikey' && !auth.apiKey) {
        errors.push('Missing required field for apikey auth: apiKey');
      }

      if (auth.type === 'oauth' && !auth.clientId) {
        errors.push('Missing required field for oauth auth: clientId');
      }

      if (auth.type === 'oauth' && !auth.tokenUrl) {
        errors.push('Missing required field for oauth auth: tokenUrl');
      }
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
  private static generateInstanceId(config: OpenAIStandardConfig): string {
    const { providerType, auth } = config.config;
    const authType = auth.type;
    const baseUrl = config.config.baseUrl || '';

    // 基于关键配置生成唯一ID
    const idComponents = [providerType, authType, baseUrl].filter(Boolean);
    return idComponents.join('-');
  }
}

/**
 * 便捷函数 - 创建Provider实例
 */
export function createOpenAIStandard(
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

export default ProviderFactory;
