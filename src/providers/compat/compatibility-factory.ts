import type { CompatibilityModule } from './compatibility-interface.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from './compatibility-interface.js';

/**
 * 兼容性模块配置接口
 * 兼容现有的RouteCodex配置文件格式
 */
export interface CompatibilityModuleConfig {
  id: string;
  type: string;
  providerType: string;
  config?: UnknownObject;
  // 兼容现有配置格式
  enabled?: boolean;
  priority?: number;
  profileId?: string;
  transformationProfile?: string;
  // Hook配置
  hookConfig?: {
    enabled: boolean;
    debugMode?: boolean;
    snapshotEnabled?: boolean;
  };
  // 其他兼容性配置
  [key: string]: unknown;
}

/**
 * 兼容性模块实例配置（运行时）
 */
export interface CompatibilityModuleInstance {
  id: string;
  config: CompatibilityModuleConfig;
  module: CompatibilityModule;
  context: CompatibilityContext;
  isInitialized: boolean;
}

/**
 * 兼容性模块工厂
 * 用于创建和管理不同类型的兼容性模块
 */
export class CompatibilityModuleFactory {
  private static readonly moduleRegistry = new Map<string, new (dependencies: ModuleDependencies) => CompatibilityModule>();

  /**
   * 注册兼容性模块类型
   */
  static registerModuleType(type: string, moduleClass: new (dependencies: ModuleDependencies) => CompatibilityModule): void {
    this.moduleRegistry.set(type, moduleClass);
  }

  /**
   * 创建兼容性模块实例
   */
  static async createModule(
    config: CompatibilityModuleConfig,
    dependencies: ModuleDependencies
  ): Promise<CompatibilityModule> {
    const ModuleClass = this.moduleRegistry.get(config.type);

    if (!ModuleClass) {
      throw new Error(`Unknown compatibility module type: ${config.type}`);
    }

    const module = new ModuleClass(dependencies) as unknown as CompatibilityModule & { setConfig?: (cfg: unknown) => void };

    // 尝试将配置传入模块（若模块支持 setConfig 钩子）
    try {
      if (typeof module.setConfig === 'function') {
        module.setConfig(config as unknown);
      }
    } catch {
      // 安全忽略：模块不支持 setConfig 或者不需要配置注入
    }

    await module.initialize();

    return module;
  }

  /**
   * 获取已注册的模块类型列表
   */
  static getRegisteredTypes(): string[] {
    return Array.from(this.moduleRegistry.keys());
  }

  /**
   * 检查模块类型是否已注册
   */
  static isTypeRegistered(type: string): boolean {
    return this.moduleRegistry.has(type);
  }
}
