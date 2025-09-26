/**
 * Configuration Merger - Fixed Version
 * 修复配置合并逻辑，确保用户配置优先于系统默认配置
 */

import type {
  ModulesConfig,
  UserConfig,
  MergedConfig,
  ModuleConfigs,
} from './merged-config-types.js';

export class ConfigMerger {
  /**
   * 合并配置 - 用户配置优先原则
   */
  mergeConfigs(
    systemConfig: ModulesConfig,
    userConfig: UserConfig,
    parsedUserConfig: any
  ): MergedConfig {
    // 修复：用户配置优先，只保留系统配置中用户未指定的部分
    const mergedModules = this.mergeModulesWithPriority(
      systemConfig.modules,
      parsedUserConfig.moduleConfigs
    );

    // 为虚拟路由模块添加解析后的配置（用户配置完全替换系统配置）
    if (mergedModules.virtualrouter && parsedUserConfig.routeTargets) {
      const baseConfig = mergedModules.virtualrouter.config;

      mergedModules.virtualrouter.config = {
        // 只保留系统配置中的基础设置（moduleType等）
        moduleType: baseConfig.moduleType,
        timeout: baseConfig.timeout,
        retryAttempts: baseConfig.retryAttempts,
        debugMode: baseConfig.debugMode,

        // 用户配置完全覆盖
        routeTargets: parsedUserConfig.routeTargets,
        pipelineConfigs: parsedUserConfig.pipelineConfigs,
        authMappings: parsedUserConfig.authMappings || {},

        // 保留其他系统配置中不在用户配置中的设置
        inputProtocol: baseConfig.inputProtocol || 'openai',
        outputProtocol: baseConfig.outputProtocol || 'openai',
      };
    }

    return {
      version: '1.0.0',
      mergedAt: new Date().toISOString(),
      modules: mergedModules,
    };
  }

  /**
   * 修复：用户配置优先的模块合并
   */
  private mergeModulesWithPriority(
    systemModules: Record<string, any>,
    userModules: Record<string, any>
  ): Record<string, any> {
    const mergedModules: Record<string, any> = {};

    // 复制系统模块占位（仅保留enable和基础moduleType，避免与用户配置重叠）
    for (const [moduleName, systemModule] of Object.entries(systemModules)) {
      if (!userModules[moduleName]) {
        mergedModules[moduleName] = { ...systemModule };
      } else {
        // 用户提供了该模块：完全采用用户配置，系统只保留moduleType占位（如需要）
        const userModule = userModules[moduleName];
        const baseModuleType = systemModule?.config?.moduleType;

        // 特殊处理：对于httpserver模块，用户配置完全覆盖系统配置
        if (moduleName === 'httpserver' && userModule.config) {
          mergedModules[moduleName] = {
            enabled: userModule.enabled ?? systemModule.enabled,
            config: {
              moduleType: baseModuleType || 'http-server',
              // 用户配置完全覆盖，不保留系统配置的其他属性
              ...userModule.config,
            },
          };
        } else {
          // 其他模块：保留moduleType，用户配置覆盖其他设置
          mergedModules[moduleName] = {
            enabled: userModule.enabled ?? systemModule.enabled,
            config: baseModuleType
              ? { moduleType: baseModuleType, ...(userModule.config || {}) }
              : { ...(userModule.config || {}) },
          };
        }
      }
    }

    // 添加用户新增模块
    for (const [moduleName, userModule] of Object.entries(userModules)) {
      if (!mergedModules[moduleName]) {
        mergedModules[moduleName] = userModule;
      }
    }

    return mergedModules;
  }

  /**
   * 修复：用户配置优先的合并策略
   */
  private mergeWithUserPriority(systemModule: any, userModule: any): any {
    // 改为整模块替换：系统仅保留moduleType占位，避免与用户重叠
    const baseModuleType = systemModule?.config?.moduleType;
    return {
      enabled: userModule.enabled ?? systemModule.enabled,
      config: baseModuleType
        ? { moduleType: baseModuleType, ...(userModule.config || {}) }
        : { ...(userModule.config || {}) },
    };
  }

  /**
   * 提取系统默认的基础配置（不含具体模型/路由配置）
   */
  private extractSystemDefaults(systemConfig: any): any {
    const defaults: any = {};

    // 保留基础设置
    if (systemConfig.moduleType !== undefined) {
      defaults.moduleType = systemConfig.moduleType;
    }
    if (systemConfig.timeout !== undefined) {
      defaults.timeout = systemConfig.timeout;
    }
    if (systemConfig.retryAttempts !== undefined) {
      defaults.retryAttempts = systemConfig.retryAttempts;
    }
    if (systemConfig.debugMode !== undefined) {
      defaults.debugMode = systemConfig.debugMode;
    }

    return defaults;
  }

  /**
   * 修复：用户配置优先的深度合并
   */
  private deepMergeWithPriority(target: any, source: any): any {
    if (target === null || target === undefined) {
      return source;
    }
    if (source === null || source === undefined) {
      return target;
    }

    // 数组：用户配置完全覆盖
    if (Array.isArray(target) && Array.isArray(source)) {
      return source; // 用户配置完全覆盖
    }

    // 对象：递归合并，但用户配置优先
    if (typeof target === 'object' && typeof source === 'object') {
      const result: any = { ...target };
      for (const [key, value] of Object.entries(source)) {
        // 特殊处理：routeTargets, pipelineConfigs, modelTiers - 用户配置完全覆盖
        if (key === 'routeTargets' || key === 'pipelineConfigs' || key === 'modelTiers') {
          result[key] = value; // 用户配置完全覆盖
        } else if (key in result) {
          result[key] = this.deepMergeWithPriority(result[key], value);
        } else {
          result[key] = value;
        }
      }
      return result;
    }

    // 标量：用户配置覆盖
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

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Public deep merge method for testing
   */
  deepMerge(target: any, source: any): any {
    return this.deepMergeWithPriority(target, source);
  }
}
