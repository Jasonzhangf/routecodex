/**
 * Configuration Merger
 * 合并系统配置和用户配置
 */

import type {
  ModulesConfig,
  UserConfig,
  MergedConfig,
  ModuleConfigs
} from './merged-config-types.js';

export class ConfigMerger {
  /**
   * 合并配置
   */
  mergeConfigs(
    systemConfig: ModulesConfig,
    userConfig: UserConfig,
    parsedUserConfig: any
  ): MergedConfig {
    const mergedModules = this.mergeModules(systemConfig.modules, parsedUserConfig.moduleConfigs);

    // 为虚拟路由模块添加解析后的配置
    if (mergedModules.virtualrouter && parsedUserConfig.routeTargets) {
      mergedModules.virtualrouter.config = {
        ...mergedModules.virtualrouter.config,
        routeTargets: parsedUserConfig.routeTargets,
        pipelineConfigs: parsedUserConfig.pipelineConfigs,
        authMappings: parsedUserConfig.authMappings || {}
      };
    }

    return {
      version: '1.0.0',
      mergedAt: new Date().toISOString(),
      modules: mergedModules
    };
  }

  /**
   * 合并模块配置
   */
  private mergeModules(
    systemModules: Record<string, any>,
    userModules: Record<string, any>
  ): Record<string, any> {
    const mergedModules: Record<string, any> = {};

    // 首先复制所有系统模块
    for (const [moduleName, systemModule] of Object.entries(systemModules)) {
      mergedModules[moduleName] = { ...systemModule };
    }

    // 然后合并用户配置
    for (const [moduleName, userModule] of Object.entries(userModules)) {
      if (mergedModules[moduleName]) {
        // 深度合并现有模块
        mergedModules[moduleName] = this.deepMerge(
          mergedModules[moduleName],
          userModule
        );
      } else {
        // 添加新模块
        mergedModules[moduleName] = userModule;
      }
    }

    return mergedModules;
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: any, source: any): any {
    if (target === null || target === undefined) return source;
    if (source === null || source === undefined) return target;

    // 数组合并：做去重并维持顺序
    if (Array.isArray(target) && Array.isArray(source)) {
      const merged = [...target, ...source];
      const seen = new Set<string>();
      const out: any[] = [];
      for (const item of merged) {
        const key = typeof item === 'object' ? JSON.stringify(item) : String(item);
        if (!seen.has(key)) { seen.add(key); out.push(item); }
      }
      return out;
    }

    // 对象：递归合并
    if (typeof target === 'object' && typeof source === 'object') {
      const result: any = { ...target };
      for (const [key, value] of Object.entries(source)) {
        result[key] = key in target ? this.deepMerge((target as any)[key], value) : value;
      }
      return result;
    }

    // 标量：以 source 覆盖
    return source;
  }

  /**
   * 验证合并后的配置
   */
  validateMergedConfig(mergedConfig: MergedConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!mergedConfig.modules) {
      errors.push('Missing modules configuration');
      return { isValid: false, errors };
    }

    // 验证虚拟路由模块配置
    const virtualRouter = mergedConfig.modules.virtualrouter;
    if (virtualRouter && virtualRouter.enabled) {
      if (!virtualRouter.config.routeTargets) {
        errors.push('Virtual router missing routeTargets configuration');
      }
      if (!virtualRouter.config.pipelineConfigs) {
        errors.push('Virtual router missing pipelineConfigs configuration');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
