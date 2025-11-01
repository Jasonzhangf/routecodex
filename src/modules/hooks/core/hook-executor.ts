/**
 * Hook执行器
 *
 * 负责Hook的具体执行逻辑，支持并行执行、串行执行、优先级调度
 * 包含错误处理、性能监控和资源管理
 */

import type {
  IBidirectionalHook,
  HookExecutionContext,
  HookDataPacket,
  HookExecutionResult,
  IHookExecutor,
  HookError,
  HookErrorType,
  HookExecutionStats,
  DataChange
} from '../types/hook-types.js';

/**
 * Hook执行器实现
 */
export class HookExecutor implements IHookExecutor {
  private stats: Map<string, HookExecutionStats> = new Map();
  private maxConcurrentHooks: number;
  private executionTimeout: number;

  constructor(options: {
    maxConcurrentHooks?: number;
    executionTimeout?: number;
  } = {}) {
    this.maxConcurrentHooks = options.maxConcurrentHooks || 10;
    this.executionTimeout = options.executionTimeout || 5000; // 5秒
  }

  /**
   * 执行单个Hook
   */
  async execute(
    hook: IBidirectionalHook,
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookName = hook.name;

    try {
      // 检查执行超时
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Hook execution timeout: ${hookName}`));
        }, this.executionTimeout);
      });

      // 执行Hook
      const executionPromise = this.executeHookInternal(hook, data, context);

      // 等待执行完成或超时
      const result = await Promise.race([executionPromise, timeoutPromise]);

      // 更新统计信息
      this.updateStats(hookName, true, Date.now() - startTime);

      return {
        hookName,
        stage: hook.stage,
        target: hook.target,
        success: true,
        executionTime: Date.now() - startTime,
        data: result.data,
        changes: result.changes,
        observations: result.observations,
        metrics: result.metrics
      };
    } catch (error) {
      // 更新错误统计
      this.updateStats(hookName, false, Date.now() - startTime, error);

      const hookError: HookError = {
        type: HookErrorType.EXECUTION_ERROR,
        message: `Hook execution failed: ${hookName}`,
        hookName,
        stage: hook.stage,
        moduleId: context.moduleId,
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now(),
        context: { executionTime: Date.now() - startTime }
      };

      // 记录错误信息
      console.error('Hook execution error:', hookError.message);

      return {
        hookName,
        stage: hook.stage,
        target: hook.target,
        success: false,
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * 并行执行多个Hook
   */
  async executeParallel(
    hooks: IBidirectionalHook[],
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<HookExecutionResult[]> {
    if (hooks.length === 0) {
      return [];
    }

    // 控制并发数量
    const chunks = this.chunkArray(hooks, this.maxConcurrentHooks);
    const allResults: HookExecutionResult[] = [];

    for (const chunk of chunks) {
      const promises = chunk.map(hook => this.execute(hook, data, context));
      const results = await Promise.allSettled(promises);

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          // 处理Promise rejection
          console.error('Hook execution promise rejected:', result.reason);
        }
      }
    }

    return allResults;
  }

  /**
   * 串行执行多个Hook（按优先级顺序）
   */
  async executeSequential(
    hooks: IBidirectionalHook[],
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];
    let currentData = data;

    for (const hook of hooks) {
      const result = await this.execute(hook, currentData, context);
      results.push(result);

      // 如果Hook执行成功且有数据变更，更新当前数据
      if (result.success && result.data !== undefined) {
        currentData = {
          ...currentData,
          data: result.data
        };
      }
    }

    return results;
  }

  /**
   * 按优先级分组执行Hook
   */
  async executeByPriority(
    hooks: IBidirectionalHook[],
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<HookExecutionResult[]> {
    // 按优先级分组
    const priorityGroups = this.groupByPriority(hooks);
    const allResults: HookExecutionResult[] = [];
    let currentData = data;

    // 按优先级顺序执行（数字越小优先级越高）
    const sortedPriorities = Array.from(priorityGroups.keys()).sort((a, b) => a - b);

    for (const priority of sortedPriorities) {
      const groupHooks = priorityGroups.get(priority)!;

      // 同优先级的Hook并行执行
      const groupResults = await this.executeParallel(groupHooks, currentData, context);
      allResults.push(...groupResults);

      // 如果有成功执行的Hook，更新数据
      const successfulResults = groupResults.filter(r => r.success && r.data !== undefined);
      if (successfulResults.length > 0) {
        // 使用最后一个成功的Hook结果作为下一个优先级组的输入
        const lastSuccessful = successfulResults[successfulResults.length - 1];
        currentData = {
          ...currentData,
          data: lastSuccessful.data
        };
      }
    }

    return allResults;
  }

  /**
   * 执行Hook内部逻辑
   */
  private async executeHookInternal(
    hook: IBidirectionalHook,
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<{
    data?: unknown;
    changes?: DataChange[];
    observations?: string[];
    metrics?: Record<string, unknown>;
  }> {
    const result = {
      data: data.data,
      changes: [] as DataChange[],
      observations: [] as string[],
      metrics: {} as Record<string, unknown>
    };

    // 执行read操作
    if (hook.read) {
      const readResult = await hook.read(data, context);
      result.observations.push(...readResult.observations);
      if (readResult.metrics) {
        Object.assign(result.metrics, readResult.metrics);
      }
    }

    // 执行transform操作
    if (hook.transform) {
      const transformResult = await hook.transform(data, context);
      result.data = transformResult.data;
      result.changes.push(...transformResult.changes);
      result.observations.push(...transformResult.observations);
      if (transformResult.metrics) {
        Object.assign(result.metrics, transformResult.metrics);
      }
    }

    // 执行write操作
    if (hook.write) {
      const writeResult = await hook.write(data, context);
      result.data = writeResult.modifiedData;
      result.changes.push(...writeResult.changes);
      result.observations.push(...writeResult.observations);
      if (writeResult.metrics) {
        Object.assign(result.metrics, writeResult.metrics);
      }
    }

    // 如果没有实现任何具体操作，执行默认的execute方法
    if (!hook.read && !hook.transform && !hook.write && hook.execute) {
      const executeResult = await hook.execute(context, data);
      result.data = executeResult.data;
      if (executeResult.observations) {
        result.observations.push(...executeResult.observations);
      }
      if (executeResult.metrics) {
        Object.assign(result.metrics, executeResult.metrics);
      }
    }

    return result;
  }

  /**
   * 将数组分块
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * 按优先级分组
   */
  private groupByPriority(hooks: IBidirectionalHook[]): Map<number, IBidirectionalHook[]> {
    const groups = new Map<number, IBidirectionalHook[]>();

    for (const hook of hooks) {
      if (!groups.has(hook.priority)) {
        groups.set(hook.priority, []);
      }
      groups.get(hook.priority)!.push(hook);
    }

    return groups;
  }

  /**
   * 更新Hook执行统计
   */
  private updateStats(
    hookName: string,
    success: boolean,
    executionTime: number,
    error?: unknown
  ): void {
    if (!this.stats.has(hookName)) {
      this.stats.set(hookName, {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        averageExecutionTime: 0,
        totalExecutionTime: 0,
        lastExecutionTime: 0,
        errorCount: 0,
        errorsByType: {}
      });
    }

    const stats = this.stats.get(hookName)!;

    stats.totalExecutions++;
    stats.lastExecutionTime = Date.now();
    stats.totalExecutionTime += executionTime;
    stats.averageExecutionTime = stats.totalExecutionTime / stats.totalExecutions;

    if (success) {
      stats.successfulExecutions++;
    } else {
      stats.failedExecutions++;
      stats.errorCount++;

      if (error) {
        const errorType = error.constructor?.name || 'Unknown';
        stats.errorsByType[errorType] = (stats.errorsByType[errorType] || 0) + 1;
      }
    }
  }

  /**
   * 获取Hook执行统计
   */
  getStats(hookName?: string): HookExecutionStats | Map<string, HookExecutionStats> {
    if (hookName) {
      return this.stats.get(hookName) || {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        averageExecutionTime: 0,
        totalExecutionTime: 0,
        lastExecutionTime: 0,
        errorCount: 0,
        errorsByType: {}
      };
    }

    return new Map(this.stats);
  }

  /**
   * 清除统计信息
   */
  clearStats(hookName?: string): void {
    if (hookName) {
      this.stats.delete(hookName);
    } else {
      this.stats.clear();
    }
  }

  /**
   * 获取执行器性能指标
   */
  getPerformanceMetrics(): {
    totalHooks: number;
    totalExecutions: number;
    averageExecutionTime: number;
    successRate: number;
    errorRate: number;
    slowestHooks: Array<{ name: string; averageTime: number }>;
    mostErrorProneHooks: Array<{ name: string; errorRate: number }>;
  } {
    const totalExecutions = Array.from(this.stats.values())
      .reduce((sum, stats) => sum + stats.totalExecutions, 0);

    const successfulExecutions = Array.from(this.stats.values())
      .reduce((sum, stats) => sum + stats.successfulExecutions, 0);

    const averageExecutionTime = totalExecutions > 0
      ? Array.from(this.stats.values())
          .reduce((sum, stats) => sum + stats.averageExecutionTime * stats.totalExecutions, 0) / totalExecutions
      : 0;

    const successRate = totalExecutions > 0 ? successfulExecutions / totalExecutions : 0;
    const errorRate = 1 - successRate;

    // 找出最慢的Hooks
    const slowestHooks = Array.from(this.stats.entries())
      .map(([name, stats]) => ({ name, averageTime: stats.averageExecutionTime }))
      .sort((a, b) => b.averageTime - a.averageTime)
      .slice(0, 5);

    // 找出最容易出错的Hooks
    const mostErrorProneHooks = Array.from(this.stats.entries())
      .map(([name, stats]) => ({
        name,
        errorRate: stats.totalExecutions > 0 ? stats.failedExecutions / stats.totalExecutions : 0
      }))
      .filter(hook => hook.errorRate > 0)
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, 5);

    return {
      totalHooks: this.stats.size,
      totalExecutions,
      averageExecutionTime,
      successRate,
      errorRate,
      slowestHooks,
      mostErrorProneHooks
    };
  }

  /**
   * 设置并发限制
   */
  setMaxConcurrentHooks(max: number): void {
    this.maxConcurrentHooks = Math.max(1, max);
  }

  /**
   * 设置执行超时
   */
  setExecutionTimeout(timeout: number): void {
    this.executionTimeout = Math.max(100, timeout); // 最小100ms
  }
}