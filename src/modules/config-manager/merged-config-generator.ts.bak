/**
 * Merged Configuration Generator
 * 生成合并后的配置文件
 */

import type {
  MergedConfig,
  ModulesConfig,
  ModuleConfigs,
  UserConfig,
  ConfigParseResult
} from '../../config/merged-config-types.js';

export class MergedConfigGenerator {
  /**
   * 生成合并配置
   */
  generateMergedConfig(
    systemConfig: ModulesConfig,
    userConfig: UserConfig,
    parsedUserConfig: ConfigParseResult
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
    systemConfig: ModulesConfig,
    _userConfig: UserConfig,
    parsedUserConfig: ConfigParseResult
  ): ModuleConfigs {
    const moduleConfigs: ModuleConfigs = {} as ModuleConfigs;

    // 复制系统模块配置
    for (const [moduleName, systemModule] of Object.entries(systemConfig.modules)) {
      (moduleConfigs as Record<string, unknown>)[moduleName] = JSON.parse(JSON.stringify(systemModule));
    }

    // 合并用户模块配置
    for (const [moduleName, userModule] of Object.entries(parsedUserConfig.moduleConfigs)) {
      if ((moduleConfigs as Record<string, unknown>)[moduleName]) {
        // 深度合并
        (moduleConfigs as Record<string, unknown>)[moduleName] = this.deepMerge(
          (moduleConfigs as Record<string, unknown>)[moduleName],
          userModule as unknown
        );
      } else {
        // 添加新模块
        (moduleConfigs as Record<string, unknown>)[moduleName] = userModule as unknown;
      }
    }

    // 为虚拟路由模块添加特殊配置 - 用户配置完全替换系统配置
    const vrModule = (moduleConfigs as Record<string, unknown>)['virtualrouter'] as Record<string, unknown> | undefined;
    const vr = vrModule ? (vrModule['config'] as Record<string, unknown> | undefined) : undefined;
    if (vr && parsedUserConfig.routeTargets) {
      const baseConfig: Record<string, unknown> = vr;

      // 保留基础设置，但routeTargets和pipelineConfigs完全使用用户配置
      ((moduleConfigs as Record<string, unknown>)['virtualrouter'] as Record<string, unknown>)['config'] = {
        // 只保留系统配置中的基础设置（moduleType等）
        moduleType: baseConfig['moduleType'],
        timeout: baseConfig['timeout'],
        retryAttempts: baseConfig['retryAttempts'],
        debugMode: baseConfig['debugMode'],

        // 用户配置完全覆盖
        routeTargets: parsedUserConfig.routeTargets,
        pipelineConfigs: parsedUserConfig.pipelineConfigs,
        authMappings: {},

        // 保留其他系统配置中不在用户配置中的设置
        inputProtocol: (baseConfig['inputProtocol'] as string) || 'openai',
        outputProtocol: (baseConfig['outputProtocol'] as string) || 'openai'
      };
    }

    return moduleConfigs;
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: unknown, source: unknown): unknown {
    if (typeof target !== 'object' || target === null) {
      return source;
    }

    if (typeof source !== 'object' || source === null) {
      return target;
    }

    const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };

    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.deepMerge((target as Record<string, unknown>)[key], value);
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
