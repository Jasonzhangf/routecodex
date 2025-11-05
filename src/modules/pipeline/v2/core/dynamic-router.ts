/**
 * Dynamic Router
 *
 * Minimal routing implementation used by V2 assembler/manager to validate
 * route patterns and build a virtual module链。严格 Fail‑Fast，不做兜底。
 */

import type { V2SystemConfig, RouteDefinition, RouteTableConfig, PipelineRequest, ValidationResult, ModuleConfig } from '../types/v2-types.js';
import type { StaticInstancePool } from './static-instance-pool.js';
import type { V2ModuleInstance } from './module-registry.js';
import { VirtualModuleChain } from './virtual-module-chain.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

export interface RouterMetrics {
  totalRoutes: number;
  lastValidationAt?: number;
  lastMatchAt?: number;
  successfulMatches: number;
  failedMatches: number;
}

export class DynamicRouter {
  private readonly pool: StaticInstancePool;
  private readonly routeTable: RouteTableConfig;
  private readonly logger: PipelineDebugLogger;

  private metrics: RouterMetrics = {
    totalRoutes: 0,
    successfulMatches: 0,
    failedMatches: 0
  };

  constructor(
    pool: StaticInstancePool,
    routeTable: V2SystemConfig['virtualPipelines']['routeTable'],
    logger?: PipelineDebugLogger
  ) {
    this.pool = pool;
    this.routeTable = routeTable;
    this.logger = logger || new PipelineDebugLogger();
    this.metrics.totalRoutes = Array.isArray(routeTable?.routes) ? routeTable.routes.length : 0;
  }

  validate(): ValidationResult {
    const errors: string[] = [];

    if (!this.routeTable || !Array.isArray(this.routeTable.routes)) {
      errors.push('routeTable.routes must be an array');
    } else {
      for (const route of this.routeTable.routes) {
        if (!route.id || typeof route.id !== 'string') {
          errors.push('route.id is required');
        }
        if (!route.pattern) {
          errors.push(`route ${route.id || '<unknown>'} missing pattern`);
        }
        if (!Array.isArray(route.modules) || route.modules.length === 0) {
          errors.push(`route ${route.id || '<unknown>'} modules must be non-empty array`);
        }
      }
    }

    const result: ValidationResult = { isValid: errors.length === 0, errors };
    this.metrics.lastValidationAt = Date.now();
    this.logger.logModule('dynamic-router', 'validate', { isValid: result.isValid, errorCount: errors.length });
    return result;
  }

  matchRoute(request: PipelineRequest): { route: RouteDefinition } | null {
    const routes = this.routeTable.routes || [];
    for (const route of routes) {
      if (this.matchesRoute(route, request)) {
        this.metrics.successfulMatches++;
        this.metrics.lastMatchAt = Date.now();
        return { route };
      }
    }

    // default route（显式指定时）
    if (this.routeTable.defaultRoute) {
      const fallback = routes.find(r => r.id === this.routeTable.defaultRoute) || null;
      if (fallback) {
        this.metrics.successfulMatches++;
        this.metrics.lastMatchAt = Date.now();
        return { route: fallback };
      }
    }

    this.metrics.failedMatches++;
    this.metrics.lastMatchAt = Date.now();
    return null;
  }

  async buildModuleChain(route: RouteDefinition, request: PipelineRequest): Promise<VirtualModuleChain | null> {
    const instances: V2ModuleInstance[] = [];
    try {
      for (const moduleSpec of route.modules) {
        const config = this.resolveModuleConfig(moduleSpec, request);
        const instance = await this.pool.getInstance(moduleSpec.type, config);
        instances.push(instance);
      }
      const chainId = `route-${route.id}-${Date.now()}`;
      const chain = new VirtualModuleChain(chainId, instances, route.id, this.logger);
      const health = chain.validateHealth();
      if (!health.isValid) {
        throw new Error(`Module chain validation failed: ${health.errors.join(', ')}`);
      }
      return chain;
    } catch (e) {
      this.logger.logModule('dynamic-router', 'build-failed', {
        routeId: route.id,
        error: e instanceof Error ? e.message : String(e)
      });
      // 清理已分配实例对应的连接（链在 VirtualModuleChain 内部负责）
      try { /* best effort: no-op */ } catch { /* ignore */ }
      return null;
    }
  }

  getMetrics(): RouterMetrics {
    return { ...this.metrics };
  }

  // --- helpers ---
  private matchesRoute(route: RouteDefinition, request: PipelineRequest): boolean {
    const body = request.body as unknown;
    // model 匹配
    if (route.pattern?.model) {
      const model = (body && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>).model : undefined;
      if (route.pattern.model instanceof RegExp) {
        if (typeof model !== 'string' || !route.pattern.model.test(model)) { return false; }
      } else if (typeof route.pattern.model === 'string') {
        if (typeof model !== 'string' || model !== route.pattern.model) { return false; }
      }
    }
    // 其它条件按需扩展（provider、hasTools 等）
    return true;
  }

  private resolveModuleConfig(moduleSpec: RouteDefinition['modules'][number], _request: PipelineRequest): ModuleConfig {
    if (typeof moduleSpec.config === 'string') {
      return { type: moduleSpec.config, config: {} };
    }
    return (moduleSpec.config || { type: moduleSpec.type, config: {} }) as ModuleConfig;
  }
}
