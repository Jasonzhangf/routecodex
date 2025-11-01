import type { CompatibilityModule, CompatibilityContext } from './compatibility-interface.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../types/module.types.js';
import type { CompatibilityModuleConfig, CompatibilityModuleInstance } from './compatibility-factory.js';
import { CompatibilityModuleFactory } from './compatibility-factory.js';

/**
 * 兼容性模块管理器
 * 负责管理所有兼容性模块的生命周期和调用
 */
export class CompatibilityManager {
  private dependencies: ModuleDependencies;
  private moduleInstances: Map<string, CompatibilityModuleInstance> = new Map();
  private isInitialized = false;

  constructor(dependencies: ModuleDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * 初始化兼容性管理器
   */
  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule('compatibility-manager', 'initializing', {});

    // 注册内置模块类型
    this.registerBuiltinModules();

    this.isInitialized = true;
    this.dependencies.logger?.logModule('compatibility-manager', 'initialized', {
      registeredTypes: CompatibilityModuleFactory.getRegisteredTypes()
    });
  }

  /**
   * 创建兼容性模块
   */
  async createModule(config: CompatibilityModuleConfig): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('CompatibilityManager not initialized');
    }

    this.dependencies.logger?.logModule('compatibility-manager', 'creating-module', {
      type: config.type,
      providerType: config.providerType
    });

    try {
      const module = await CompatibilityModuleFactory.createModule(config, this.dependencies);

      // 创建兼容性上下文
      const context: CompatibilityContext = {
        compatibilityId: module.id,
        profileId: config.profileId || `${config.providerType}-default`,
        providerType: config.providerType,
        direction: 'incoming',
        stage: 'initialization',
        requestId: `init-${Date.now()}`,
        executionId: `exec-${Date.now()}`,
        timestamp: Date.now(),
        startTime: Date.now(),
        metadata: {
          dataSize: 0,
          dataKeys: [],
          config: config.config
        }
      };

      // 创建模块实例
      const moduleInstance: CompatibilityModuleInstance = {
        id: module.id,
        config,
        module,
        context,
        isInitialized: true
      };

      this.moduleInstances.set(module.id, moduleInstance);

      this.dependencies.logger?.logModule('compatibility-manager', 'module-created', {
        moduleId: module.id,
        type: config.type,
        providerType: config.providerType
      });

      return module.id;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'CompatibilityManager',
        operation: 'createModule',
        config
      });
      throw error;
    }
  }

  /**
   * 从标准配置文件批量加载兼容性模块
   */
  async loadModulesFromConfig(configPath: string): Promise<string[]> {
    if (!this.isInitialized) {
      throw new Error('CompatibilityManager not initialized');
    }

    this.dependencies.logger?.logModule('compatibility-manager', 'loading-modules-from-config', {
      configPath
    });

    try {
      const configContent = await this.loadConfigFile(configPath);
      const moduleIds: string[] = [];

      // 处理兼容性模块配置
      if (config.compatibility && Array.isArray(config.compatibility.modules)) {
        for (const moduleConfig of config.compatibility.modules) {
          const moduleId = await this.createModule(moduleConfig);
          moduleIds.push(moduleId);
        }
      }

      this.dependencies.logger?.logModule('compatibility-manager', 'modules-loaded-from-config', {
        configPath,
        moduleCount: moduleIds.length,
        moduleIds
      });

      return moduleIds;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'CompatibilityManager',
        operation: 'loadModulesFromConfig',
        configPath
      });
      throw error;
    }
  }

  /**
   * 加载配置文件
   */
  private async loadConfigFile(configPath: string): Promise<any> {
    const fs = await import('fs/promises');
    const path = await import('path');

    try {
      const configContent = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configContent);
    } catch (error) {
      throw new Error(`Failed to load config file: ${configPath}`);
    }
  }

  /**
   * 获取兼容性模块
   */
  getModule(moduleId: string): CompatibilityModule | undefined {
    const instance = this.moduleInstances.get(moduleId);
    return instance?.module;
  }

  /**
   * 获取模块实例
   */
  getModuleInstance(moduleId: string): CompatibilityModuleInstance | undefined {
    return this.moduleInstances.get(moduleId);
  }

  /**
   * 获取所有兼容性模块
   */
  getAllModules(): CompatibilityModule[] {
    return Array.from(this.moduleInstances.values()).map(instance => instance.module);
  }

  /**
   * 获取所有模块实例
   */
  getAllModuleInstances(): CompatibilityModuleInstance[] {
    return Array.from(this.moduleInstances.values());
  }

  /**
   * 根据Provider类型获取兼容性模块
   */
  getModulesByProviderType(providerType: string): CompatibilityModule[] {
    return Array.from(this.moduleInstances.values())
      .filter(instance => instance.module.providerType === providerType)
      .map(instance => instance.module);
  }

  /**
   * 处理请求
   */
  async processRequest(
    moduleId: string,
    request: UnknownObject,
    context?: CompatibilityContext
  ): Promise<UnknownObject> {
    const instance = this.moduleInstances.get(moduleId);
    if (!instance) {
      throw new Error(`Compatibility module not found: ${moduleId}`);
    }

    const processingContext = context || this.createProcessingContext(instance, 'incoming', request);

    this.dependencies.logger?.logModule('compatibility-manager', 'process-request-start', {
      moduleId,
      requestId: processingContext.requestId
    });

    try {
      const result = await instance.module.processIncoming(request, processingContext);

      this.dependencies.logger?.logModule('compatibility-manager', 'process-request-success', {
        moduleId,
        requestId: processingContext.requestId
      });

      return result;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'CompatibilityManager',
        operation: 'processRequest',
        moduleId,
        requestId: processingContext.requestId
      });
      throw error;
    }
  }

  /**
   * 处理响应
   */
  async processResponse(
    moduleId: string,
    response: UnknownObject,
    context?: CompatibilityContext
  ): Promise<UnknownObject> {
    const instance = this.moduleInstances.get(moduleId);
    if (!instance) {
      throw new Error(`Compatibility module not found: ${moduleId}`);
    }

    const processingContext = context || this.createProcessingContext(instance, 'outgoing', response);

    this.dependencies.logger?.logModule('compatibility-manager', 'process-response-start', {
      moduleId,
      requestId: processingContext.requestId
    });

    try {
      const result = await instance.module.processOutgoing(response, processingContext);

      this.dependencies.logger?.logModule('compatibility-manager', 'process-response-success', {
        moduleId,
        requestId: processingContext.requestId
      });

      return result;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'CompatibilityManager',
        operation: 'processResponse',
        moduleId,
        requestId: processingContext.requestId
      });
      throw error;
    }
  }

  /**
   * 创建处理上下文
   */
  private createProcessingContext(
    instance: CompatibilityModuleInstance,
    direction: 'incoming' | 'outgoing',
    data: UnknownObject
  ): CompatibilityContext {
    return {
      compatibilityId: instance.id,
      profileId: instance.config.profileId || `${instance.config.providerType}-default`,
      providerType: instance.config.providerType,
      direction,
      stage: direction === 'incoming' ? 'request_processing' : 'response_processing',
      requestId: `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      executionId: `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      startTime: Date.now(),
      metadata: {
        dataSize: JSON.stringify(data).length,
        dataKeys: Object.keys(data),
        moduleConfig: instance.config.config
      }
    };
  }

  /**
   * 删除兼容性模块
   */
  async removeModule(moduleId: string): Promise<void> {
    const module = this.modules.get(moduleId);
    if (!module) {
      return;
    }

    this.dependencies.logger?.logModule('compatibility-manager', 'removing-module', {
      moduleId
    });

    try {
      await module.cleanup();
      this.modules.delete(moduleId);

      this.dependencies.logger?.logModule('compatibility-manager', 'module-removed', {
        moduleId
      });
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'CompatibilityManager',
        operation: 'removeModule',
        moduleId
      });
      throw error;
    }
  }

  /**
   * 清理所有模块
   */
  async cleanup(): Promise<void> {
    this.dependencies.logger?.logModule('compatibility-manager', 'cleanup-start', {
      moduleCount: this.modules.size
    });

    const cleanupPromises = Array.from(this.modules.entries()).map(async ([id, module]) => {
      try {
        await module.cleanup();
      } catch (error) {
        this.dependencies.logger?.logError?.(error as Error, {
          component: 'CompatibilityManager',
          operation: 'cleanup',
          moduleId: id
        });
      }
    });

    await Promise.all(cleanupPromises);
    this.modules.clear();
    this.isInitialized = false;

    this.dependencies.logger?.logModule('compatibility-manager', 'cleanup-complete', {});
  }

  /**
   * 获取模块统计信息
   */
  getStats(): UnknownObject {
    const stats = {
      totalModules: this.modules.size,
      isInitialized: this.isInitialized,
      registeredTypes: CompatibilityModuleFactory.getRegisteredTypes(),
      modulesByType: {} as Record<string, number>,
      modulesByProvider: {} as Record<string, number>
    };

    for (const module of this.modules.values()) {
      stats.modulesByType[module.type] = (stats.modulesByType[module.type] || 0) + 1;
      if (module.providerType) {
        stats.modulesByProvider[module.providerType] = (stats.modulesByProvider[module.providerType] || 0) + 1;
      }
    }

    return stats;
  }

  /**
   * 注册内置模块类型
   */
  private registerBuiltinModules(): void {
    // 在这里注册内置的兼容性模块类型
    // GLM模块会在这里注册
  }
}