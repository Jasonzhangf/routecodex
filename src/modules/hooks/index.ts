/**
 * 独立Hooks模块统一导出入口
 *
 * 提供完整的Hook系统功能，包括核心组件、服务层和适配器
 */

// 核心组件导出
export * from './core/index.js';

// 类型定义导出
export * from './types/hook-types.js';

// 服务层导出
export * from './service/snapshot/index.js';

// 适配器层导出
export * from './provider-adapters/provider-adapter.js';

/**
 * 创建完整的Hook系统实例
 *
 * 这是推荐的Hook系统创建方式，包含所有必需的组件和配置
 */
export function createHooksSystem(options: {
  // 核心配置
  maxConcurrentHooks?: number;
  executionTimeout?: number;
  enableHealthCheck?: boolean;
  healthCheckInterval?: number;

  // 快照服务配置
  snapshotEnabled?: boolean;
  snapshotConfig?: unknown;

  // 调试配置
  debugMode?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
} = {}) {
  const {
    maxConcurrentHooks = 10,
    executionTimeout = 5000,
    enableHealthCheck = false,
    healthCheckInterval = 30000,
    snapshotEnabled = true,
    snapshotConfig,
    debugMode = false
  } = options;

  // 导入核心组件
  import { createHookSystem as createCoreHookSystem } from './core/index.js';
  import { SnapshotServiceFactory } from './service/snapshot/index.js';
  import { ProviderAdapter } from './provider-adapters/provider-adapter.js';

  // 创建核心Hook系统
  const coreSystem = createCoreHookSystem({
    maxConcurrentHooks,
    executionTimeout,
    enableHealthCheck,
    healthCheckInterval
  });

  // 创建快照服务
  let snapshotService = null;
  if (snapshotEnabled) {
    const config = snapshotConfig || (debugMode
      ? SnapshotServiceFactory.createDevelopment()
      : SnapshotServiceFactory.createProduction()
    );
    snapshotService = config;
  }

  // 创建Provider适配器
  const providerAdapter = new ProviderAdapter(coreSystem);

  // 统一的Hook系统实例
  const hooksSystem = {
    // 核心组件
    hookManager: coreSystem.hookManager,
    hookExecutor: coreSystem.hookExecutor,
    hookRegistry: coreSystem.hookRegistry,
    lifecycleManager: coreSystem.lifecycleManager,

    // 服务层
    snapshotService,

    // 适配器层
    providerAdapter,

    // 便捷方法
    async initialize() {
      await coreSystem.lifecycleManager.initialize();
    },

    async start() {
      await coreSystem.lifecycleManager.start();
    },

    async stop() {
      await coreSystem.lifecycleManager.stop();
    },

    async shutdown() {
      if (snapshotService && snapshotService.shutdown) {
        await snapshotService.shutdown();
      }
      await coreSystem.lifecycleManager.shutdown();
    },

    // 健康检查
    async healthCheck() {
      const coreHealth = await coreSystem.hookManager.healthCheck();

      let snapshotHealth = { healthy: true, issues: [] };
      if (snapshotService && snapshotService.getStats) {
        const stats = snapshotService.getStats();
        if (stats.queueSize > 100) {
          snapshotHealth = {
            healthy: false,
            issues: [`Snapshot queue too large: ${stats.queueSize}`]
          };
        }
      }

      return {
        healthy: coreHealth.healthy && snapshotHealth.healthy,
        issues: [...coreHealth.issues, ...snapshotHealth.issues],
        components: {
          core: coreHealth,
          snapshot: snapshotHealth
        }
      };
    },

    // 统计信息
    getStats() {
      const coreStats = coreSystem.hookManager.getStats();
      const snapshotStats = snapshotService ? snapshotService.getStats() : null;

      return {
        core: coreStats,
        snapshot: snapshotStats,
        system: coreSystem.lifecycleManager.getSystemInfo()
      };
    },

    // 调试配置
    setDebugConfig(config: unknown) {
      // 设置调试配置到Hook管理器
      console.log('Debug config set:', config);
    }
  };

  return hooksSystem;
}

/**
 * 默认Hook系统配置
 */
export const DEFAULT_HOOKS_CONFIG = {
  maxConcurrentHooks: 10,
  executionTimeout: 5000,
  enableHealthCheck: false,
  healthCheckInterval: 30000,
  snapshotEnabled: true,
  debugMode: false,
  logLevel: 'info' as const
};

/**
 * Hook系统版本信息
 */
export const HOOKS_MODULE_VERSION = {
  major: 1,
  minor: 0,
  patch: 0,
  version: '1.0.0',
  name: 'RouteCodex Independent Hooks Module',
  description: 'Unified hook system for RouteCodex pipeline architecture'
};