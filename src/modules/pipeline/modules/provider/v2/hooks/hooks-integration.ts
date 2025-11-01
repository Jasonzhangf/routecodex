/**
 * Provider V2 Hook系统集成
 *
 * 将独立Hook系统集成到Provider V2中，保持完全向后兼容
 * 同时提供增强的快照和监控功能
 */

import type { OpenAIStandardConfig } from '../api/provider-config.js';

// 临时类型定义，避免导入路径问题
interface ModuleDependencies {
  logger?: {
    logModule: (moduleId: string, event: string, data?: any) => void;
  };
  configEngine?: any;
  errorHandlingCenter?: any;
  debugCenter?: any;
}

// 导入独立Hook系统
const { createHooksSystem } = require('../../../../hooks/index.js');

/**
 * Hook系统集成配置
 */
interface HookSystemIntegrationConfig {
  enabled: boolean;
  debugMode: boolean;
  snapshotEnabled: boolean;
  migrationMode: boolean; // 是否迁移现有Hooks
}

/**
 * Hook系统集成类
 */
export class HookSystemIntegration {
  private config: HookSystemIntegrationConfig;
  private hooksSystem: any = null;
  private legacyManager: any = null;
  private dependencies: ModuleDependencies;
  private providerId: string;

  constructor(
    dependencies: ModuleDependencies,
    providerId: string,
    config: Partial<HookSystemIntegrationConfig> = {}
  ) {
    this.dependencies = dependencies;
    this.providerId = providerId;
    this.config = {
      enabled: true,
      debugMode: true,
      snapshotEnabled: true,
      migrationMode: true,
      ...config
    };
  }

  /**
   * 初始化Hook系统集成
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      // 创建Hook系统实例
      this.hooksSystem = createHooksSystem({
        maxConcurrentHooks: 10,
        executionTimeout: 5000,
        enableHealthCheck: this.config.debugMode,
        healthCheckInterval: 30000,
        snapshotEnabled: this.config.snapshotEnabled,
        snapshotConfig: {
          basePath: '~/.routecodex/codex-samples',
          format: 'structured',
          compression: 'gzip',
          sampling: {
            enabled: !this.config.debugMode, // 调试模式下不采样
            defaultRate: this.config.debugMode ? 1.0 : 0.2,
            moduleRates: {
              'provider-v2': this.config.debugMode ? 1.0 : 0.3
            }
          }
        },
        debugMode: this.config.debugMode,
        logLevel: this.config.debugMode ? 'debug' : 'info'
      });

      // 初始化Hook系统
      await this.hooksSystem.initialize();

      // 创建BidirectionalHookManager包装器
      this.legacyManager = this.hooksSystem.providerAdapter.createLegacyManagerWrapper();

      // 迁移现有Hooks（如果启用）
      if (this.config.migrationMode) {
        await this.migrateExistingHooks();
      }

      // 注册Provider特定的Hooks
      await this.registerProviderHooks();

      this.dependencies.logger?.logModule(this.providerId, 'hook-system-integrated', {
        providerId: this.providerId,
        debugMode: this.config.debugMode,
        snapshotEnabled: this.config.snapshotEnabled,
        migrationMode: this.config.migrationMode
      });

    } catch (error) {
      this.dependencies.logger?.logModule(this.providerId, 'hook-system-integration-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * 迁移现有的Provider V2 Hooks
   */
  private async migrateExistingHooks(): Promise<void> {
    try {
      // 动态导入现有Hook管理器和调试Hooks
      const { BidirectionalHookManager } = await import('../config/provider-debug-hooks.js');
      const { registerDebugExampleHooks } = await import('../hooks/debug-example-hooks.js');

      // 注册调试示例Hooks到旧系统
      registerDebugExampleHooks();

      // 迁移现有静态Hooks（如果存在）
      // BidirectionalHookManager是静态类，无需实例化
      if (this.hooksSystem.providerAdapter.migrateExistingHooks) {
        this.hooksSystem.providerAdapter.migrateExistingHooks(BidirectionalHookManager);
      }

      this.dependencies.logger?.logModule(this.providerId, 'existing-hooks-migrated', {
        providerId: this.providerId
      });

    } catch (error) {
      this.dependencies.logger?.logModule(this.providerId, 'hook-migration-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      // 不抛出错误，允许系统继续运行
    }
  }

  /**
   * 注册Provider特定的Hooks
   */
  private async registerProviderHooks(): Promise<void> {
    try {
      // 注册快照记录Hook
      this.hooksSystem.hookManager.registerHook({
        name: 'provider-snapshot-recorder',
        stage: 'response_postprocessing' as any,
        target: 'response',
        priority: 999, // 最低优先级，确保最后执行
        isDebugHook: false,
        async execute(context: unknown, data: unknown) {
          if (this.config.snapshotEnabled && this.hooksSystem.snapshotService) {
            try {
              // 保存快照
              await this.hooksSystem.snapshotService.saveSnapshot(
                'provider-v2',
                (context as any).requestId || 'unknown',
                (context as any).stage,
                [], // 执行结果将在其他地方收集
                context
              );
            } catch (error) {
              console.error('Failed to save provider snapshot:', error);
            }
          }
          return { success: true, executionTime: 0 };
        }
      }, 'provider-v2');

    } catch (error) {
      this.dependencies.logger?.logModule(this.providerId, 'provider-hook-registration-error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 获取BidirectionalHookManager（保持API兼容）
   */
  getBidirectionalHookManager(): unknown {
    if (!this.config.enabled) {
      // 如果Hook系统未启用，返回空的兼容实现
      return this.createLegacyCompatibilityManager();
    }

    return this.legacyManager || this.createLegacyCompatibilityManager();
  }

  /**
   * 创建传统兼容管理器
   */
  private createLegacyCompatibilityManager(): unknown {
    return {
      registerHook: () => {},
      unregisterHook: () => {},
      executeHookChain: async (stage: unknown, target: unknown, data: unknown, context: unknown) => {
        return { data, metrics: { executionTime: 0, hookCount: 0, successCount: 0 } };
      },
      setDebugConfig: () => {}
    };
  }

  /**
   * 设置调试配置
   */
  setDebugConfig(config: unknown): void {
    if (this.hooksSystem && this.hooksSystem.setDebugConfig) {
      this.hooksSystem.setDebugConfig(config);
    }
  }

  /**
   * 获取Hook系统统计信息
   */
  getStats(): unknown {
    if (!this.hooksSystem) {
      return { enabled: false };
    }

    return this.hooksSystem.getStats ? this.hooksSystem.getStats() : { enabled: false };
  }

  /**
   * 执行健康检查
   */
  async healthCheck(): Promise<any> {
    if (!this.hooksSystem) {
      return { healthy: true, issues: ['Hook system not initialized'] };
    }

    return this.hooksSystem.healthCheck ? await this.hooksSystem.healthCheck() : { healthy: true, issues: [] };
  }

  /**
   * 启动Hook系统
   */
  async start(): Promise<void> {
    if (this.hooksSystem && this.hooksSystem.start) {
      await this.hooksSystem.start();
    }
  }

  /**
   * 停止Hook系统
   */
  async stop(): Promise<void> {
    if (this.hooksSystem && this.hooksSystem.stop) {
      await this.hooksSystem.stop();
    }
  }

  /**
   * 关闭Hook系统
   */
  async shutdown(): Promise<void> {
    if (this.hooksSystem && this.hooksSystem.shutdown) {
      await this.hooksSystem.shutdown();
    }
  }
}

/**
 * 创建Hook系统集成实例
 */
export function createHookSystemIntegration(
  dependencies: ModuleDependencies,
  providerId: string,
  config?: Partial<HookSystemIntegrationConfig>
): HookSystemIntegration {
  return new HookSystemIntegration(dependencies, providerId, config);
}

/**
 * 默认集成配置
 */
export const DEFAULT_INTEGRATION_CONFIG: HookSystemIntegrationConfig = {
  enabled: true,
  debugMode: false,
  snapshotEnabled: true,
  migrationMode: true
};