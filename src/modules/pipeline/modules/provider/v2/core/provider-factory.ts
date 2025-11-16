/**
 * Provider Factory - Provider实例创建工厂
 *
 * 提供统一的Provider实例创建和管理功能
 */

import { OpenAIStandard } from './openai-standard.js';
import { ResponsesProvider } from './responses-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import crypto from 'node:crypto';
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

    // 真正的 Responses provider：用于 OpenAI Responses wire (/v1/responses)
    if (ptype === 'responses') {
      provider = new ResponsesProvider(config, dependencies);
    } else {
      // 默认：OpenAI 标准 Chat provider（兼容 glm/qwen 等 openai-standard upstream）
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
    const supportedTypes = ['openai', 'glm', 'qwen', 'iflow', 'lmstudio', 'responses', 'anthropic'];
    if (config.config.providerType && !supportedTypes.includes(config.config.providerType)) {
      errors.push(`Unsupported providerType: ${config.config.providerType}. Supported types: ${supportedTypes.join(', ')}`);
    }

    // 验证认证配置
    if (config.config.auth) {
      const auth = config.config.auth;
      if (auth.type === 'apikey' && !auth.apiKey) {
        errors.push('Missing required field for apikey auth: apiKey');
      }

      if (auth.type === 'oauth') {
        const ptype = String(config.config.providerType || '').toLowerCase();
        const isQwen = ptype === 'qwen';
        const isIflow = ptype === 'iflow';

        // 对于 qwen / iflow 等内置 OAuth provider，clientId/tokenUrl 可从默认配置或环境推断，
        // 因此不强制要求在用户配置中显式提供，避免硬编码凭证。
        if (!auth.clientId && !isQwen && !isIflow) {
          errors.push('Missing required field for oauth auth: clientId');
        }

        if (!auth.tokenUrl && !isQwen && !isIflow) {
          errors.push('Missing required field for oauth auth: tokenUrl');
        }
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
    // 将“认证身份”纳入实例ID，避免不同 key 复用同一实例
    let authIdentity = '';
    try {
      if (authType === 'apikey' && typeof (auth as any).apiKey === 'string') {
        const key = String((auth as any).apiKey);
        authIdentity = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
      } else if (authType === 'oauth') {
        const tokenFile = (auth as any).tokenFile || '';
        const clientId = (auth as any).clientId || '';
        authIdentity = crypto.createHash('sha256').update(String(tokenFile || clientId)).digest('hex').slice(0, 12);
      }
    } catch { authIdentity = ''; }

    // 基于关键配置生成唯一ID（包含认证身份摘要）
    const idComponents = [providerType, authType, baseUrl, authIdentity].filter(Boolean);
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
