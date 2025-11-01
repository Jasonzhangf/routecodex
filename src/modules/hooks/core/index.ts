/**
 * Hooks核心模块导出
 *
 * 统一导出所有核心组件，包括Hook管理器、执行器、注册中心和生命周期管理器
 */

// 类型导出
export type {
  // 核心接口
  IHook,
  IBidirectionalHook,
  IHookManager,
  IHookExecutor,
  IHookRegistry,
  IModuleAdapter,
  ILifecycleManager,
  IErrorHandler,

  // 数据类型
  HookResult,
  HookExecutionContext,
  HookDataPacket,
  ReadResult,
  WriteResult,
  TransformResult,
  DataChange,
  HookExecutionResult,
  HookConfig,
  HookRegistration,
  HookFilter,
  HookExecutionStats,
  SnapshotData,
  MetricsData,
  HookError,
  ErrorHandlingResult,

  // 枚举类型
  UnifiedHookStage,
  HookTarget,
  HookSystemState,
  HookErrorType
} from '../types/hook-types.js';

// 实现类导出
export { HookManager } from './hook-manager.js';
export { HookExecutor } from './hook-executor.js';
export { HookRegistry } from './hook-registry.js';
export { LifecycleManager, LifecycleManagerFactory } from './lifecycle-manager.js';

// 工厂函数导出
export { HookManagerFactory } from './hook-manager.js';

// 工具函数导出
export {
  providerV2StageToUnified,
  unifiedStageToProviderV2,
  isBidirectionalHook,
  isProviderV2HookStage
} from '../types/hook-types.js';

/**
 * 创建完整的Hook系统实例
 */
export function createHookSystem(options: {
  maxConcurrentHooks?: number;
  executionTimeout?: number;
  enableHealthCheck?: boolean;
  healthCheckInterval?: number;
}): {
  hookManager: IHookManager;
  hookExecutor: IHookExecutor;
  hookRegistry: IHookRegistry;
  lifecycleManager: ILifecycleManager;
} {
  const {
    maxConcurrentHooks = 10,
    executionTimeout = 5000,
    enableHealthCheck = false,
    healthCheckInterval = 30000
  } = options;

  // 创建核心组件
  const hookRegistry = new HookRegistry();
  const hookExecutor = new HookExecutor({
    maxConcurrentHooks,
    executionTimeout
  });
  const lifecycleManager = new LifecycleManager();

  // 创建Hook管理器
  const hookManager = HookManagerFactory.createWithConfig(
    hookRegistry,
    hookExecutor,
    lifecycleManager,
    {
      maxConcurrentHooks,
      enableHealthCheck,
      healthCheckInterval
    }
  );

  // 设置组件间的引用关系
  lifecycleManager.setHookManager(hookManager);

  return {
    hookManager,
    hookExecutor,
    hookRegistry,
    lifecycleManager
  };
}

/**
 * Hook系统默认配置
 */
export const DEFAULT_HOOK_SYSTEM_CONFIG = {
  maxConcurrentHooks: 10,
  executionTimeout: 5000,
  enableHealthCheck: false,
  healthCheckInterval: 30000,
  debugMode: false,
  logLevel: 'info' as const
};

/**
 * Hook系统版本信息
 */
export const HOOK_SYSTEM_VERSION = {
  major: 1,
  minor: 0,
  patch: 0,
  version: '1.0.0',
  name: 'RouteCodex Hook System'
};