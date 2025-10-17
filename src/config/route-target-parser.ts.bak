/**
 * Route Target Parser
 * 解析路由字符串为目标配置
 */

import type { RouteTarget, RouteTargetPool } from './merged-config-types.js';

export class RouteTargetParser {
  /**
   * 解析路由字符串
   */
  parseRouteString(routeString: string): RouteTarget {
    const parts = routeString.split('.');

    // 支持两种格式：
    // 1. provider.model → 使用provider的所有key（负载均衡）
    // 2. provider.model.key → 只使用指定key
    if (parts.length === 2) {
      // provider.model格式：使用provider的所有key
      const [providerId, modelId] = parts;
      return {
        providerId,
        modelId,
        keyId: '*', // 通配符表示使用所有key
        actualKey: '*', // 通配符表示使用所有key
        inputProtocol: 'openai',
        outputProtocol: 'openai',
      };
    } else if (parts.length === 3) {
      // provider.model.key格式：只使用指定key
      const [providerId, modelId, keyId] = parts;
      return {
        providerId,
        modelId,
        keyId,
        actualKey: keyId, // 将由AuthFileResolver解析
        inputProtocol: 'openai',
        outputProtocol: 'openai',
      };
    } else {
      throw new Error(
        `Invalid route string format: ${routeString}. Expected format: provider.model or provider.model.key`
      );
    }
  }

  /**
   * 解析路由配置
   */
  parseRoutingConfig(routingConfig: Record<string, string[]>): RouteTargetPool {
    const routeTargetPool: RouteTargetPool = {};

    for (const [routeName, targets] of Object.entries(routingConfig)) {
      routeTargetPool[routeName] = targets.map(target => this.parseRouteString(target));
    }

    return routeTargetPool;
  }

  /**
   * 验证路由目标
   */
  validateRouteTarget(target: RouteTarget): boolean {
    return (
      target.providerId.length > 0 &&
      target.modelId.length > 0 &&
      target.keyId.length > 0 && // keyId现在总是存在，因为两段式格式会设置default
      target.inputProtocol.length > 0 &&
      target.outputProtocol.length > 0
    );
  }

  /**
   * 验证路由配置
   */
  validateRoutingConfig(routeTargetPool: RouteTargetPool): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [routeName, targets] of Object.entries(routeTargetPool)) {
      if (!targets || targets.length === 0) {
        errors.push(`Route ${routeName} has no targets`);
        continue;
      }

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!this.validateRouteTarget(target)) {
          errors.push(`Invalid target at index ${i} in route ${routeName}`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}
