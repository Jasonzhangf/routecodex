/**
 * Provider适配器 - 桥接Provider v2与统一Hook系统
 *
 * 确保现有Provider v2的BidirectionalHookManager API完全兼容，
 * 同时将现有Hook迁移到统一的Hook管理系统中
 */

import type {
  IBidirectionalHook,
  HookExecutionContext,
  HookDataPacket,
  HookExecutionResult,
  UnifiedHookStage,
  HookTarget,
  HookConfig,
  IModuleAdapter,
  ProviderV2HookStage,
  ProviderV2BidirectionalHook,
  providerV2StageToUnified,
  unifiedStageToProviderV2
} from '../types/hook-types.js';

// Provider v2现有类型的导入（避免循环依赖）
interface LegacyBidirectionalHookManager {
  registerHook(hook: unknown): void;
  unregisterHook(hookName: string): void;
  executeHookChain(
    stage: unknown,
    target: unknown,
    data: unknown,
    context: unknown
  ): Promise<unknown>;
  setDebugConfig(config: unknown): void;
}

interface LegacyHookExecutionContext {
  executionId: string;
  stage: string;
  startTime: number;
  requestId?: string;
}


/**
 * Provider适配器类
 * 负责桥接Provider v2的现有Hook系统与新的统一Hook系统
 */
export class ProviderAdapter implements IModuleAdapter {
  readonly moduleId = 'provider-v2';

  constructor(private hooksModule: unknown) {} // 避免循环依赖

  /**
   * 注册Provider v2的BidirectionalHook到统一系统
   */
  registerHook(hookConfig: HookConfig): void {
    const unifiedHook = this.convertToUnifiedHook(hookConfig);
    const hookManager = this.hooksModule.getHookManager();
    hookManager.registerHook(unifiedHook, this.moduleId);
  }

  /**
   * 注销Hook
   */
  unregisterHook(hookName: string): void {
    const hookManager = this.hooksModule.getHookManager();
    hookManager.unregisterHook(hookName);
  }

  /**
   * 启用Hooks
   */
  enableHooks(): void {
    this.hooksModule.enableHooks();
  }

  /**
   * 禁用Hooks
   */
  disableHooks(): void {
    this.hooksModule.disableHooks();
  }

  /**
   * 获取Hook状态
   */
  getHookStatus(): { enabled: boolean; hookCount: number } {
    return {
      enabled: this.hooksModule.isEnabled(),
      hookCount: this.hooksModule.getHookCount()
    };
  }

  /**
   * 将现有Provider v2的BidirectionalHook转换为统一Hook接口
   */
  private convertToUnifiedHook(hookConfig: HookConfig): IBidirectionalHook {
    return {
      name: hookConfig.name,
      stage: hookConfig.stage,
      target: hookConfig.target,
      priority: hookConfig.priority,
      isDebugHook: hookConfig.isDebugHook,

      async execute(context: HookExecutionContext, data: HookDataPacket): Promise<HookExecutionResult> {
        const startTime = Date.now();

        try {
          if (hookConfig.handler) {
            const result = await hookConfig.handler(context, data);
            return {
              hookName: hookConfig.name,
              stage: context.stage,
              target: hookConfig.target,
              success: true,
              executionTime: Date.now() - startTime,
              data: result.data,
              observations: result.observations,
              metrics: result.metrics
            };
          }

          return {
            hookName: hookConfig.name,
            stage: context.stage,
            target: hookConfig.target,
            success: true,
            executionTime: Date.now() - startTime,
            data: data.data
          };
        } catch (error) {
          return {
            hookName: hookConfig.name,
            stage: context.stage,
            target: hookConfig.target,
            success: false,
            executionTime: Date.now() - startTime,
            error: error instanceof Error ? error : new Error(String(error))
          };
        }
      }
    };
  }

  /**
   * 迁移现有的Provider v2 Hooks到统一系统
   */
  migrateExistingHooks(legacyManager: LegacyBidirectionalHookManager): void {
    // 这里需要通过反射或访问私有属性来获取已注册的Hooks
    // 实际实现中可能需要在BidirectionalHookManager中添加获取方法
    try {
      // 假设有一个方法可以获取现有的Hooks
      const existingHooks = this.getLegacyHooks(legacyManager);

      for (const legacyHook of existingHooks) {
        const unifiedHook = this.wrapLegacyHook(legacyHook);
        const hookManager = this.hooksModule.getHookManager();
        hookManager.registerHook(unifiedHook, this.moduleId);
      }
    } catch (error) {
      console.warn('Failed to migrate existing Provider v2 hooks:', error);
    }
  }

  /**
   * 包装现有Provider v2 Hook
   */
  private wrapLegacyHook(legacyHook: ProviderV2BidirectionalHook): IBidirectionalHook {
    return {
      name: legacyHook.name,
      stage: providerV2StageToUnified(legacyHook.stage as ProviderV2HookStage),
      target: legacyHook.target as HookTarget,
      priority: legacyHook.priority,
      isDebugHook: legacyHook.isDebugHook,
      read: legacyHook.read ? async (data: HookDataPacket, context: HookExecutionContext) => {
        const legacyContext = this.convertContextToLegacy(context);
        return await legacyHook.read!(data, legacyContext);
      } : undefined,
      write: legacyHook.write ? async (data: HookDataPacket, context: HookExecutionContext) => {
        const legacyContext = this.convertContextToLegacy(context);
        return await legacyHook.write!(data, legacyContext);
      } : undefined,
      transform: legacyHook.transform ? async (data: HookDataPacket, context: HookExecutionContext) => {
        const legacyContext = this.convertContextToLegacy(context);
        return await legacyHook.transform!(data, legacyContext);
      } : undefined,
      async execute(context: HookExecutionContext, data: HookDataPacket): Promise<HookExecutionResult> {
        const startTime = Date.now();

        try {
          const result = { data: data.data, changes: [], observations: [] };

          // 执行read操作
          if (legacyHook.read) {
            const legacyContext = this.convertContextToLegacy(context);
            const readResult = await legacyHook.read(data, legacyContext);
            result.observations.push(...readResult.observations);
          }

          // 执行transform操作
          if (legacyHook.transform) {
            const legacyContext = this.convertContextToLegacy(context);
            const transformResult = await legacyHook.transform(data, legacyContext);
            result.data = transformResult.data;
            result.changes.push(...transformResult.changes);
            result.observations.push(...transformResult.observations);
          }

          // 执行write操作
          if (legacyHook.write) {
            const legacyContext = this.convertContextToLegacy(context);
            const writeResult = await legacyHook.write(data, legacyContext);
            result.data = writeResult.modifiedData;
            result.changes.push(...writeResult.changes);
            result.observations.push(...writeResult.observations);
          }

          return {
            hookName: legacyHook.name,
            stage: context.stage,
            target: legacyHook.target as HookTarget,
            success: true,
            executionTime: Date.now() - startTime,
            data: result.data,
            changes: result.changes,
            observations: result.observations
          };
        } catch (error) {
          return {
            hookName: legacyHook.name,
            stage: context.stage,
            target: legacyHook.target as HookTarget,
            success: false,
            executionTime: Date.now() - startTime,
            error: error instanceof Error ? error : new Error(String(error))
          };
        }
      }
    };
  }

  /**
   * 转换执行上下文到Provider v2格式
   */
  private convertContextToLegacy(context: HookExecutionContext): LegacyHookExecutionContext {
    return {
      executionId: context.executionId,
      stage: unifiedStageToProviderV2(context.stage) || context.stage,
      startTime: context.startTime,
      requestId: context.requestId
    };
  }

  /**
   * 获取现有的Provider v2 Hooks（需要访问私有属性）
   */
  private getLegacyHooks(legacyManager: LegacyBidirectionalHookManager): ProviderV2BidirectionalHook[] {
    // 这是一个占位实现，实际中需要在BidirectionalHookManager中添加获取方法
    // 或者通过反射访问私有属性
    try {
      // 尝试访问hooks数组（假设存在）
      if ((legacyManager as any).hooks) {
        return (legacyManager as any).hooks;
      }
    } catch (error) {
      console.warn('Cannot access legacy hooks:', error);
    }

    return [];
  }

  /**
   * 创建BidirectionalHookManager包装器，保持API兼容
   */
  public createLegacyManagerWrapper(): LegacyBidirectionalHookManager {
    return new BidirectionalHookManagerWrapper(this.hooksModule);
  }
}

/**
 * BidirectionalHookManager包装器
 * 保持现有API完全兼容，内部使用新的Hook系统
 */
class BidirectionalHookManagerWrapper implements LegacyBidirectionalHookManager {
  private hooksModule: unknown;
  private providerAdapter: ProviderAdapter;

  constructor(hooksModule: unknown) {
    this.hooksModule = hooksModule;
    this.providerAdapter = new ProviderAdapter(hooksModule);
  }

  /**
   * 注册Hook - 保持原有API
   */
  registerHook(hook: ProviderV2BidirectionalHook): void {
    const unifiedHook = this.providerAdapter['wrapLegacyHook'](hook);
    const hookManager = this.hooksModule.getHookManager();
    hookManager.registerHook(unifiedHook, 'provider-v2');
  }

  /**
   * 注销Hook - 保持原有API
   */
  unregisterHook(hookName: string): void {
    const hookManager = this.hooksModule.getHookManager();
    hookManager.unregisterHook(hookName);
  }

  /**
   * 执行Hook链 - 保持原有API
   */
  async executeHookChain(
    stage: ProviderV2HookStage,
    target: HookTarget,
    data: unknown,
    context: LegacyHookExecutionContext
  ): Promise<unknown> {
    const hookManager = this.hooksModule.getHookManager();
    const unifiedStage = providerV2StageToUnified(stage);

    const unifiedContext: HookExecutionContext = {
      executionId: context.executionId,
      stage: unifiedStage,
      startTime: context.startTime,
      requestId: context.requestId,
      moduleId: 'provider-v2'
    };

  
    const results = await hookManager.executeHooks(
      unifiedStage,
      target,
      data,
      unifiedContext
    );

    // 返回兼容原有格式的结果
    const finalResult = results[results.length - 1];
    return {
      data: finalResult?.data || data,
      metrics: {
        executionTime: results.reduce((sum, r) => sum + r.executionTime, 0),
        hookCount: results.length,
        successCount: results.filter(r => r.success).length
      }
    };
  }

  /**
   * 设置调试配置 - 保持原有API
   */
  setDebugConfig(config: unknown): void {
    // 将Provider v2的调试配置转换为统一配置
    const unifiedConfig = {
      enabled: config.enabled !== false,
      level: config.level || 'detailed',
      maxDataSize: config.maxDataSize || 1024,
      stages: Object.values(UnifiedHookStage),
      outputFormat: config.outputFormat || 'structured',
      outputTargets: config.outputTargets || ['console'],
      performanceThresholds: config.performanceThresholds || {
        maxHookExecutionTime: 100,
        maxTotalExecutionTime: 1000,
        maxDataSize: 512 * 1024
      }
    };

    this.hooksModule.setDebugConfig(unifiedConfig);
  }
}

/**
 * 工厂函数：创建Provider适配器
 */
export function createProviderAdapter(hooksModule: unknown): ProviderAdapter {
  return new ProviderAdapter(hooksModule);
}

/**
 * 工厂函数：创建BidirectionalHookManager包装器
 */
export function createLegacyManagerWrapper(hooksModule: unknown): LegacyBidirectionalHookManager {
  return new BidirectionalHookManagerWrapper(hooksModule);
}

/**
 * 工具函数：检查Hook是否为Provider v2格式
 */
export function isProviderV2Hook(hook: unknown): hook is ProviderV2BidirectionalHook {
  return hook &&
         typeof hook.name === 'string' &&
         typeof hook.stage === 'string' &&
         typeof hook.target === 'string' &&
         typeof hook.priority === 'number' &&
         (typeof hook.read === 'function' ||
          typeof hook.write === 'function' ||
          typeof hook.transform === 'function');
}

/**
 * 工具函数：迁移现有Provider v2 Hooks
 */
export function migrateProviderV2Hooks(
  hooksModule: unknown,
  legacyHooks: ProviderV2BidirectionalHook[]
): void {
  const adapter = createProviderAdapter(hooksModule);

  for (const legacyHook of legacyHooks) {
    if (isProviderV2Hook(legacyHook)) {
      const unifiedHook = adapter['wrapLegacyHook'](legacyHook);
      const hookManager = hooksModule.getHookManager();
      hookManager.registerHook(unifiedHook, 'provider-v2');
    }
  }
}