/**
 * OAuth混合流程策略
 *
 * 根据配置选择具体的OAuth流程，不提供自动回退机制
 */

import type { UnknownObject } from '../../../types/common-types.js';
import { BaseOAuthFlowStrategy, OAuthFlowType } from '../config/oauth-flows.js';
import type { OAuthFlowConfig } from '../config/oauth-flows.js';
import { OAuthDeviceFlowStrategy } from './oauth-device-flow.js';
import { OAuthAuthCodeFlowStrategy } from './oauth-auth-code-flow.js';

/**
 * OAuth混合流程策略配置
 */
export interface OAuthHybridFlowConfig extends OAuthFlowConfig {
  /** 流程类型 */
  flowType: OAuthFlowType.DEVICE_CODE | OAuthFlowType.AUTHORIZATION_CODE;
}

/**
 * OAuth混合流程策略 - 简化版本，不支持回退
 */
export class OAuthHybridFlowStrategy extends BaseOAuthFlowStrategy {
  private strategy: BaseOAuthFlowStrategy;
  private hybridConfig: OAuthHybridFlowConfig;

  constructor(config: OAuthHybridFlowConfig, httpClient?: typeof fetch, tokenFile?: string) {
    super(config, httpClient);
    this.hybridConfig = config;

    // 根据配置创建策略
    this.strategy = this.createStrategy(config.flowType, httpClient, tokenFile);
  }

  /**
   * 创建OAuth策略
   */
  private createStrategy(flowType: OAuthFlowType, httpClient?: typeof fetch, tokenFile?: string): BaseOAuthFlowStrategy {
    switch (flowType) {
      case OAuthFlowType.DEVICE_CODE:
        return new OAuthDeviceFlowStrategy(this.config, httpClient, tokenFile);
      case OAuthFlowType.AUTHORIZATION_CODE:
        return new OAuthAuthCodeFlowStrategy(this.config, httpClient, tokenFile);
      default:
        throw new Error(`Unsupported OAuth flow type: ${flowType}`);
    }
  }

  /**
   * 执行OAuth认证流程 - 主动策略，失败即报错
   */
  async authenticate(options: { openBrowser?: boolean } = {}): Promise<UnknownObject> {
    console.log(`Starting OAuth flow: ${this.hybridConfig.flowType}...`);

    try {
      // 1. 尝试加载现有令牌
      const existingToken = await this.loadToken();
      if (existingToken && this.validateToken(existingToken)) {
        console.log('Using existing valid token');
        return existingToken;
      }

      // 2. 如果令牌过期但可以刷新，则尝试刷新
      if (existingToken && (existingToken as any).refresh_token) {
        console.log('Token expired, attempting refresh...');
        const refreshedToken = await this.refreshToken((existingToken as any).refresh_token);
        await this.saveToken(refreshedToken);
        console.log('Token refreshed successfully');
        return refreshedToken;
      }

      // 3. 执行配置的OAuth流程
      console.log(`Executing OAuth flow: ${this.hybridConfig.flowType}`);
      const token = await this.strategy.authenticate(options);
      console.log(`${this.hybridConfig.flowType} flow completed successfully!`);
      return token;

    } catch (error) {
      console.error(`OAuth ${this.hybridConfig.flowType} flow failed`);
      throw error;
    }
  }

  /**
   * 刷新令牌
   */
  async refreshToken(refreshToken: string): Promise<UnknownObject> {
    return this.strategy.refreshToken(refreshToken);
  }

  /**
   * 验证令牌
   */
  validateToken(token: UnknownObject): boolean {
    return this.strategy.validateToken(token);
  }

  /**
   * 获取授权头部
   */
  getAuthHeader(token: UnknownObject): string {
    return this.strategy.getAuthHeader(token);
  }

  /**
   * 保存令牌
   */
  async saveToken(token: UnknownObject): Promise<void> {
    await this.strategy.saveToken(token);
  }

  /**
   * 加载令牌
   */
  async loadToken(): Promise<UnknownObject | null> {
    return this.strategy.loadToken();
  }
}

/**
 * 混合流程策略工厂
 */
export class OAuthHybridFlowStrategyFactory {
  createStrategy(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string): BaseOAuthFlowStrategy {
    return new OAuthHybridFlowStrategy(config as OAuthHybridFlowConfig, httpClient, tokenFile);
  }

  getFlowType(): OAuthFlowType {
    return OAuthFlowType.HYBRID;
  }
}
