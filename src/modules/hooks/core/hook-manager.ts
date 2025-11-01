/**
 * 统一Hook管理器
 *
 * 核心Hook管理组件，负责Hook的注册、执行和生命周期管理
 * 支持优先级排序、并行执行、错误处理和性能监控
 */

import type {
  IBidirectionalHook,
  HookExecutionContext,
  HookDataPacket,
  HookExecutionResult,
  UnifiedHookStage,
  HookTarget,
  HookRegistration,
  HookFilter,
  IHookManager,
  IHookExecutor,
  IHookRegistry,
  HookError,
  HookErrorType,
  HookSystemState,
  ILifecycleManager
} from '../types/hook-types.js';

/**
 * Hook管理器实现
 */
export class HookManager implements IHookManager {
  private registry: IHookRegistry;
  private executor: IHookExecutor;
  private lifecycleManager: ILifecycleManager;
  private state: HookSystemState = HookSystemState.UNINITIALIZED;
  private stateChangeCallbacks: Array<(oldState: HookSystemState, newState: HookSystemState) => void> = [];

  constructor(
    registry: IHookRegistry,
    executor: IHookExecutor,
    lifecycleManager: ILifecycleManager
  ) {
    this.registry = registry;
    this.executor = executor;
    this.lifecycleManager = lifecycleManager;

    // 监听生命周期状态变化
    this.lifecycleManager.onStateChange((oldState, newState) => {
      this.setState(newState);
    });
  }

  /**
   * 注册Hook
   */
  registerHook(hook: IBidirectionalHook, moduleId?: string): void {
    if (this.state !== HookSystemState.RUNNING && this.state !== HookSystemState.PAUSED) {
      throw new Error(`Cannot register hooks in state: ${this.state}`);
    }

    try {
      this.registry.register(hook, moduleId);
      console.log(`Hook registered: ${hook.name} (${moduleId || 'global'})`);
    } catch (error) {
      const hookError: HookError = {
        type: HookErrorType.REGISTRATION_ERROR,
        message: `Failed to register hook: ${hook.name}`,
        hookName: hook.name,
        moduleId,
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now()
      };
      this.handleError(hookError);
      throw error;
    }
  }

  /**
   * 注销Hook
   */
  unregisterHook(hookName: string): void {
    try {
      this.registry.unregister(hookName);
      console.log(`Hook unregistered: ${hookName}`);
    } catch (error) {
      const hookError: HookError = {
        type: HookErrorType.REGISTRATION_ERROR,
        message: `Failed to unregister hook: ${hookName}`,
        hookName,
        timestamp: Date.now(),
        cause: error instanceof Error ? error : new Error(String(error))
      };
      this.handleError(hookError);
    }
  }

  /**
   * 执行Hooks
   */
  async executeHooks(
    stage: UnifiedHookStage,
    target: HookTarget,
    data: unknown,
    context: HookExecutionContext
  ): Promise<HookExecutionResult[]> {
    if (this.state !== HookSystemState.RUNNING) {
      console.warn(`Hook execution attempted in state: ${this.state}`);
      return [];
    }

    const startTime = Date.now();

    try {
      // 查找匹配的Hooks
      const hooks = this.registry.find(stage, target);

      if (hooks.length === 0) {
        return [];
      }

      // 创建数据包
      const dataPacket: HookDataPacket = {
        data,
        metadata: {
          size: JSON.stringify(data).length,
          timestamp: Date.now(),
          source: context.moduleId,
          target: target
        }
      };

      // 按优先级排序
      hooks.sort((a, b) => a.priority - b.priority);

      // 执行Hooks
      const results = await this.executor.executeParallel(hooks, dataPacket, context);

      // 记录执行统计
      const executionTime = Date.now() - startTime;
      console.log(`Executed ${hooks.length} hooks for stage ${stage} in ${executionTime}ms`);

      return results;
    } catch (error) {
      const hookError: HookError = {
        type: HookErrorType.EXECUTION_ERROR,
        message: `Failed to execute hooks for stage ${stage}`,
        stage,
        moduleId: context.moduleId,
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now(),
        context: { target, executionTime: Date.now() - startTime }
      };
      this.handleError(hookError);

      // 根据错误处理策略决定是否抛出错误
      if (this.shouldFailFast(error)) {
        throw error;
      }

      return [];
    }
  }

  /**
   * 获取已注册的Hooks
   */
  getRegisteredHooks(filter?: HookFilter): HookRegistration[] {
    const allHooks = this.registry.getAll();

    if (!filter) {
      return allHooks.map(hook => ({
        hook,
        moduleId: 'global',
        registeredAt: Date.now()
      }));
    }

    return allHooks
      .filter(hook => this.matchesFilter(hook, filter))
      .map(hook => ({
        hook,
        moduleId: 'global',
        registeredAt: Date.now()
      }));
  }

  /**
   * 清除所有Hooks
   */
  clearHooks(): void {
    this.registry.clear();
    console.log('All hooks cleared');
  }

  /**
   * 获取系统状态
   */
  getState(): HookSystemState {
    return this.state;
  }

  /**
   * 监听状态变化
   */
  onStateChange(callback: (oldState: HookSystemState, newState: HookSystemState) => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  /**
   * 设置系统状态
   */
  private setState(newState: HookSystemState): void {
    const oldState = this.state;
    this.state = newState;

    // 通知状态变化监听器
    this.stateChangeCallbacks.forEach(callback => {
      try {
        callback(oldState, newState);
      } catch (error) {
        console.error('Error in state change callback:', error);
      }
    });
  }

  /**
   * 处理错误
   */
  private handleError(error: HookError): void {
    console.error('Hook system error:', {
      type: error.type,
      message: error.message,
      hookName: error.hookName,
      stage: error.stage,
      moduleId: error.moduleId,
      timestamp: error.timestamp
    });

    // 这里可以集成错误报告服务
    // 例如：errorReporter.report(error);
  }

  /**
   * 判断是否应该快速失败
   */
  private shouldFailFast(error: unknown): boolean {
    // 核心路径错误应该快速失败
    if (error.type === HookErrorType.REGISTRATION_ERROR ||
        error.type === HookErrorType.VALIDATION_ERROR ||
        error.type === HookErrorType.LIFECYCLE_ERROR) {
      return true;
    }

    // 执行错误默认继续执行，但记录警告
    return false;
  }

  /**
   * 检查Hook是否匹配过滤条件
   */
  private matchesFilter(hook: IBidirectionalHook, filter: HookFilter): boolean {
    // 检查阶段过滤
    if (filter.stages && !filter.stages.includes(hook.stage)) {
      return false;
    }

    // 检查目标过滤
    if (filter.targets && !filter.targets.includes(hook.target)) {
      return false;
    }

    // 检查优先级范围
    if (filter.priorityRange) {
      const { min, max } = filter.priorityRange;
      if (hook.priority < min || hook.priority > max) {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取系统统计信息
   */
  getStats(): {
    state: HookSystemState;
    totalHooks: number;
    hooksByStage: Record<string, number>;
    hooksByTarget: Record<string, number>;
  } {
    const stats = this.registry.getStats();

    return {
      state: this.state,
      totalHooks: stats.totalHooks,
      hooksByStage: stats.hooksByStage,
      hooksByTarget: stats.hooksByTarget
    };
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    state: HookSystemState;
    issues: string[];
    stats: unknown;
  }> {
    const issues: string[] = [];

    // 检查系统状态
    if (this.state !== HookSystemState.RUNNING) {
      issues.push(`System not running: ${this.state}`);
    }

    // 检查注册中心
    try {
      const hookCount = this.registry.getAll().length;
      if (hookCount === 0) {
        issues.push('No hooks registered');
      }
    } catch (error) {
      issues.push('Registry health check failed');
    }

    // 检查执行器
    try {
      // 简单的执行器健康检查
      const testHook: IBidirectionalHook = {
        name: 'health-check',
        stage: 'initialization' as UnifiedHookStage,
        target: 'all',
        priority: 999,
        async execute() {
          return { success: true, executionTime: 0 };
        }
      };

      const testContext: HookExecutionContext = {
        executionId: 'health-check',
        stage: 'initialization' as UnifiedHookStage,
        startTime: Date.now()
      };

      const testData: HookDataPacket = {
        data: { test: true },
        metadata: { size: 10, timestamp: Date.now() }
      };

      await this.executor.execute(testHook, testData, testContext);
    } catch (error) {
      issues.push('Executor health check failed');
    }

    return {
      healthy: issues.length === 0,
      state: this.state,
      issues,
      stats: this.getStats()
    };
  }
}

/**
 * Hook管理器工厂
 */
export class HookManagerFactory {
  /**
   * 创建默认Hook管理器
   */
  static createDefault(
    registry: IHookRegistry,
    executor: IHookExecutor,
    lifecycleManager: ILifecycleManager
  ): HookManager {
    return new HookManager(registry, executor, lifecycleManager);
  }

  /**
   * 创建带配置的Hook管理器
   */
  static createWithConfig(
    registry: IHookRegistry,
    executor: IHookExecutor,
    lifecycleManager: ILifecycleManager,
    config: {
      maxConcurrentHooks?: number;
      enableHealthCheck?: boolean;
      healthCheckInterval?: number;
    }
  ): HookManager {
    const manager = new HookManager(registry, executor, lifecycleManager);

    // 配置健康检查
    if (config.enableHealthCheck && config.healthCheckInterval) {
      setInterval(async () => {
        const health = await manager.healthCheck();
        if (!health.healthy) {
          console.warn('Hook system health issues:', health.issues);
        }
      }, config.healthCheckInterval);
    }

    return manager;
  }
}