/**
 * Merged Configuration Generator
 * 生成合并后的配置文件
 */

import type { MergedConfig } from '../../config/merged-config-types.js';

export class MergedConfigGenerator {
  /**
   * 生成合并配置
   */
  generateMergedConfig(
    systemConfig: any,
    userConfig: any,
    parsedUserConfig: any
  ): MergedConfig {
    return {
      version: '1.0.0',
      mergedAt: new Date().toISOString(),
      modules: this.generateModuleConfigs(systemConfig, userConfig, parsedUserConfig)
    };
  }

  /**
   * 生成模块配置
   */
  private generateModuleConfigs(
    systemConfig: any,
    userConfig: any,
    parsedUserConfig: any
  ): any {
    const moduleConfigs: any = {};

    // 复制系统模块配置
    for (const [moduleName, systemModule] of Object.entries(systemConfig.modules)) {
      moduleConfigs[moduleName] = JSON.parse(JSON.stringify(systemModule));
    }

    // 合并用户模块配置
    for (const [moduleName, userModule] of Object.entries(parsedUserConfig.moduleConfigs)) {
      if (moduleConfigs[moduleName]) {
        // 深度合并
        moduleConfigs[moduleName] = this.deepMerge(
          moduleConfigs[moduleName],
          userModule
        );
      } else {
        // 添加新模块
        moduleConfigs[moduleName] = userModule;
      }
    }

    // 为虚拟路由模块添加特殊配置
    if (moduleConfigs.virtualrouter && parsedUserConfig.routeTargets) {
      moduleConfigs.virtualrouter.config = {
        ...moduleConfigs.virtualrouter.config,
        routeTargets: parsedUserConfig.routeTargets,
        pipelineConfigs: parsedUserConfig.pipelineConfigs
      };
    }

    return moduleConfigs;
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: any, source: any): any {
    if (typeof target !== 'object' || target === null) {
      return source;
    }

    if (typeof source !== 'object' || source === null) {
      return target;
    }

    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.deepMerge(target[key], value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 验证合并配置
   */
  validateMergedConfig(mergedConfig: MergedConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!mergedConfig.modules) {
      errors.push('Missing modules configuration');
      return { isValid: false, errors };
    }

    // 验证必需的模块
    const requiredModules = ['virtualrouter', 'httpserver', 'configmanager'];
    for (const moduleName of requiredModules) {
      if (!mergedConfig.modules[moduleName]) {
        errors.push(`Missing required module: ${moduleName}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
