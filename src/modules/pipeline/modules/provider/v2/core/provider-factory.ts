/**
 * Provider Factory - Provider实例创建工厂
 *
 * 提供统一的Provider实例创建和管理功能
 */

import { OpenAIStandard } from './openai-standard.js';
import { ResponsesProvider } from './responses-provider.js';
import { OpenAIHttpProvider } from './openai-http-provider.js';
import { ResponsesHttpProvider } from './responses-http-provider.js';
import { AnthropicHttpProvider } from './anthropic-http-provider.js';
import { iFlowHttpProvider } from './iflow-http-provider.js';
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

    // 创建新实例
    const ptype = String(config?.config?.providerType || '').toLowerCase();
    const moduleType = String(config?.type || '').toLowerCase();
    let provider: IProviderV2;

    // 1) 新的 HTTP Provider 模块（按协议族拆分）
    if (moduleType === 'openai-http-provider') {
      provider = new OpenAIHttpProvider(config, dependencies);
    } else if (moduleType === 'responses-http-provider') {
      provider = new ResponsesHttpProvider(config, dependencies);
    } else if (moduleType === 'anthropic-http-provider') {
      provider = new AnthropicHttpProvider(config, dependencies);
    } else if (ptype === 'iflow') {
      // iFlow 使用专用的 HTTP Provider，支持 OAuth
      provider = new iFlowHttpProvider(config, dependencies);
    } else if (ptype === 'responses') {
      // 2) 兼容旧路径：仍使用 ResponsesProvider（真实 Responses wire /v1/responses）
      provider = new ResponsesProvider(config, dependencies);
    } else {
      // 3) 默认：OpenAI 标准 Provider：
      //  - providerType='openai'/'glm'/'qwen'/'lmstudio' → Chat 形状；
      //  - providerType='anthropic' → 通过 ServiceProfile 选择 /v1/messages wire（协议转换由 llmswitch-core 处理）。
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
  private static generateInstanceId(config: OpenAIStandardConfig): string {
    const providerType = config?.config?.providerType || 'unknown';
    const baseUrl = config?.config?.baseUrl || '';
    const authType = config?.config?.auth?.type || '';
    const input = `${providerType}:${baseUrl}:${authType}`;
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
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
