/**
 * Route Target Pool
 * 路由目标池管理
 */

export class RouteTargetPool {
  private targets: Map<string, RouteTarget[]> = new Map();
  private healthStatus: Map<string, boolean> = new Map();

  /**
   * 添加路由目标
   */
  addRouteTargets(routeName: string, targets: RouteTarget[]): void {
    this.targets.set(routeName, targets);

    // 初始化健康状态
    for (const target of targets) {
      const targetKey = this.getTargetKey(target);
      this.healthStatus.set(targetKey, true);
    }
  }

  /**
   * 获取路由目标
   */
  getRouteTargets(routeName: string): RouteTarget[] {
    return this.targets.get(routeName) || [];
  }

  /**
   * 获取健康的路由目标
   */
  getHealthyTargets(routeName: string): RouteTarget[] {
    const targets = this.getRouteTargets(routeName);
    return targets.filter(target => {
      const targetKey = this.getTargetKey(target);
      return this.healthStatus.get(targetKey) || false;
    });
  }

  /**
   * 更新目标健康状态
   */
  updateTargetHealth(target: RouteTarget, isHealthy: boolean): void {
    const targetKey = this.getTargetKey(target);
    this.healthStatus.set(targetKey, isHealthy);
  }

  /**
   * 获取所有路由名称
   */
  getRouteNames(): string[] {
    return Array.from(this.targets.keys());
  }

  /**
   * 获取目标统计信息
   */
  getStatistics(): RoutePoolStatistics {
    const stats: RoutePoolStatistics = {
      totalRoutes: this.targets.size,
      totalTargets: 0,
      healthyTargets: 0,
      unhealthyTargets: 0,
      routeDetails: {}
    };

    for (const [routeName, targets] of this.targets) {
      const healthyCount = targets.filter(target => {
        const targetKey = this.getTargetKey(target);
        return this.healthStatus.get(targetKey) || false;
      }).length;

      stats.totalTargets += targets.length;
      stats.healthyTargets += healthyCount;
      stats.unhealthyTargets += targets.length - healthyCount;

      stats.routeDetails[routeName] = {
        totalTargets: targets.length,
        healthyTargets: healthyCount,
        unhealthyTargets: targets.length - healthyCount
      };
    }

    return stats;
  }

  /**
   * 生成目标键
   */
  private getTargetKey(target: RouteTarget): string {
    return `${target.providerId}.${target.modelId}.${target.keyId}`;
  }
}

// 类型定义
interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
}

interface RoutePoolStatistics {
  totalRoutes: number;
  totalTargets: number;
  healthyTargets: number;
  unhealthyTargets: number;
  routeDetails: Record<string, {
    totalTargets: number;
    healthyTargets: number;
    unhealthyTargets: number;
  }>;
}
