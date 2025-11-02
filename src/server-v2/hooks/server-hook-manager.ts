/**
 * Server Hook Manager V2
 *
 * 集成系统hooks模块的Hook管理器
 * 为Server V2提供统一的Hook执行接口
 */

import type { UnknownObject } from '../../types/common-types.js';
import type { RequestContextV2 } from '../core/route-codex-server-v2.js';

/**
 * Hook执行上下文
 */
export interface HookExecutionContext {
  requestId: string;
  stage: string;
  timestamp: number;
  data: UnknownObject;
}

/**
 * Hook执行结果
 */
export interface HookExecutionResult {
  success: boolean;
  data?: UnknownObject;
  error?: string;
  executionTime: number;
  observations?: string[];
}

/**
 * Server Hook管理器
 */
export class ServerHookManager {
  private enabled: boolean;
  private hooks: Map<string, Function[]> = new Map();
  private executionStats: Map<string, { count: number; totalTime: number; errors: number }> = new Map();

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
    console.log(`[ServerHookManager] Initialized (enabled: ${enabled})`);

    if (enabled) {
      this.initializeDefaultHooks();
    }
  }

  /**
   * 初始化默认Hooks
   */
  private initializeDefaultHooks(): void {
    console.log('[ServerHookManager] Initializing default hooks');

    // 请求预处理Hooks
    this.registerHook('request_preprocessing', this.createRequestLoggingHook());
    this.registerHook('request_preprocessing', this.createRequestValidationHook());

    // 响应后处理Hooks
    this.registerHook('response_postprocessing', this.createResponseLoggingHook());
    this.registerHook('response_postprocessing', this.createResponseMetricsHook());

    // 错误处理Hooks
    this.registerHook('error_handling', this.createErrorLoggingHook());
    this.registerHook('error_handling', this.createErrorMetricsHook());
  }

  /**
   * 注册Hook
   */
  registerHook(stage: string, hook: Function): void {
    if (!this.enabled) {
      console.warn(`[ServerHookManager] Hooks are disabled, ignoring registration for stage: ${stage}`);
      return;
    }

    if (!this.hooks.has(stage)) {
      this.hooks.set(stage, []);
    }

    this.hooks.get(stage)!.push(hook);
    console.log(`[ServerHookManager] Registered hook for stage: ${stage}`);
  }

  /**
   * 执行Hooks
   */
  async executeHooks(
    stage: string,
    data: UnknownObject,
    context: RequestContextV2
  ): Promise<HookExecutionResult> {
    if (!this.enabled) {
      return {
        success: true,
        data,
        executionTime: 0,
        observations: ['Hooks are disabled']
      };
    }

    const startTime = Date.now();
    const hooks = this.hooks.get(stage) || [];

    if (hooks.length === 0) {
      return {
        success: true,
        data,
        executionTime: Date.now() - startTime,
        observations: [`No hooks registered for stage: ${  stage}`]
      };
    }

    console.log(`[ServerHookManager] Executing ${hooks.length} hooks for stage: ${stage}, request: ${context.requestId}`);

    try {
      let currentData = data;
      const observations: string[] = [];

      // 按顺序执行所有hooks
      for (let i = 0; i < hooks.length; i++) {
        const hook = hooks[i];
        const hookName = `${stage}_hook_${i + 1}`;

        try {
          const hookResult = await hook(currentData, context);

          if (hookResult && typeof hookResult === 'object') {
            currentData = hookResult;
            observations.push(`Hook ${hookName} executed successfully`);
          } else {
            observations.push(`Hook ${hookName} returned no data`);
          }

          // 更新统计
          this.updateStats(stage, Date.now() - startTime, false);

        } catch (hookError) {
          const error = hookError as Error;
          const errorMessage = `Hook ${hookName} failed: ${error.message}`;
          console.error(`[ServerHookManager] ${errorMessage}`);
          observations.push(errorMessage);

          // 更新错误统计
          this.updateStats(stage, Date.now() - startTime, true);

          // 根据配置决定是否继续执行
          if (this.shouldStopOnHookError(stage, error)) {
            throw new Error(`Hook execution stopped at ${hookName}: ${error.message}`);
          }
        }
      }

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        data: currentData,
        executionTime,
        observations
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;
      const err = error as Error;
      this.updateStats(stage, executionTime, true);

      return {
        success: false,
        error: err.message,
        executionTime,
        observations: [`Hook chain failed: ${err.message}`]
      };
    }
  }

  /**
   * 创建请求日志Hook
   */
  private createRequestLoggingHook(): Function {
    return async (data: UnknownObject, context: RequestContextV2): Promise<UnknownObject> => {
      const logData = {
        requestId: context.requestId,
        method: context.method,
        url: context.url,
        endpoint: context.endpoint,
        timestamp: context.timestamp,
        userAgent: context.userAgent,
        ip: context.ip
      };

      console.log(`[Hook:RequestLogging] ${JSON.stringify(logData, null, 2)}`);
      return data;
    };
  }

  /**
   * 创建请求验证Hook
   */
  private createRequestValidationHook(): Function {
    return async (data: UnknownObject, context: RequestContextV2): Promise<UnknownObject> => {
      // 基础验证
      if (!data || typeof data !== 'object') {
        throw new Error('Request data must be an object');
      }

      const body = data as any;

      // 检查必要字段
      if (!body.model) {
        console.warn(`[Hook:RequestValidation] Missing model field for request ${context.requestId}`);
      }

      if (!body.messages || !Array.isArray(body.messages)) {
        throw new Error('Messages field must be an array');
      }

      console.log(`[Hook:RequestValidation] Request validation passed for ${context.requestId}`);
      return data;
    };
  }

  /**
   * 创建响应日志Hook
   */
  private createResponseLoggingHook(): Function {
    return async (data: UnknownObject, context: RequestContextV2): Promise<UnknownObject> => {
      const logData = {
        requestId: context.requestId,
        hasResponse: !!data,
        responseModel: (data as any)?.model,
        responseChoices: (data as any)?.choices?.length || 0,
        timestamp: Date.now()
      };

      console.log(`[Hook:ResponseLogging] ${JSON.stringify(logData, null, 2)}`);
      return data;
    };
  }

  /**
   * 创建响应指标Hook
   */
  private createResponseMetricsHook(): Function {
    return async (data: UnknownObject, context: RequestContextV2): Promise<UnknownObject> => {
      const response = data as any;

      // 添加响应指标
      if (response && typeof response === 'object') {
        response._metrics = {
          serverVersion: 'v2',
          processedAt: Date.now(),
          requestId: context.requestId,
          hookProcessed: true
        };
      }

      return data;
    };
  }

  /**
   * 创建错误日志Hook
   */
  private createErrorLoggingHook(): Function {
    return async (error: Error, context: RequestContextV2): Promise<void> => {
      const errorData = {
        requestId: context.requestId,
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack
        },
        context: {
          method: context.method,
          url: context.url,
          endpoint: context.endpoint,
          timestamp: context.timestamp
        }
      };

      console.error(`[Hook:ErrorLogging] ${JSON.stringify(errorData, null, 2)}`);
    };
  }

  /**
   * 创建错误指标Hook
   */
  private createErrorMetricsHook(): Function {
    return async (error: Error, context: RequestContextV2): Promise<void> => {
      // 这里可以发送错误指标到监控系统
      console.log(`[Hook:ErrorMetrics] Error recorded for request ${context.requestId}: ${error.message}`);
    };
  }

  /**
   * 更新Hook执行统计
   */
  private updateStats(stage: string, executionTime: number, isError: boolean): void {
    if (!this.executionStats.has(stage)) {
      this.executionStats.set(stage, { count: 0, totalTime: 0, errors: 0 });
    }

    const stats = this.executionStats.get(stage)!;
    stats.count++;
    stats.totalTime += executionTime;

    if (isError) {
      stats.errors++;
    }
  }

  /**
   * 判断是否应该在Hook错误时停止执行
   */
  private shouldStopOnHookError(stage: string, _error: Error): boolean {
    // 对于关键阶段，错误时停止执行
    const criticalStages = ['request_validation', 'authentication'];
    return criticalStages.includes(stage);
  }

  /**
   * 获取Hook执行统计
   */
  getExecutionStats(): UnknownObject {
    const stats: UnknownObject = {};

    for (const [stage, data] of this.executionStats.entries()) {
      stats[stage] = {
        executions: data.count,
        totalTime: data.totalTime,
        averageTime: data.count > 0 ? data.totalTime / data.count : 0,
        errors: data.errors,
        errorRate: data.count > 0 ? data.errors / data.count : 0
      };
    }

    return stats;
  }

  /**
   * 清理Hook
   */
  clearHooks(stage?: string): void {
    if (stage) {
      this.hooks.delete(stage);
      console.log(`[ServerHookManager] Cleared hooks for stage: ${stage}`);
    } else {
      this.hooks.clear();
      console.log('[ServerHookManager] Cleared all hooks');
    }
  }

  /**
   * 获取已注册的Hook阶段
   */
  getRegisteredStages(): string[] {
    return Array.from(this.hooks.keys());
  }

  /**
   * 启用/禁用Hook管理器
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[ServerHookManager] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}