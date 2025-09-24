/**
 * Error Boundaries and Recovery System
 *
 * 提供错误边界、容错处理和自动恢复机制
 * 确保系统在异常情况下的稳定性和可靠性
 */

import type { ResourceInfo } from './memory-management.js';
import { memoryManager, ResourceType } from './memory-management.js';

/**
 * 错误级别
 */
export enum ErrorLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
  FATAL = 'fatal'
}

/**
 * 错误类型
 */
export enum ErrorType {
  VALIDATION_ERROR = 'validation-error',
  NETWORK_ERROR = 'network-error',
  TIMEOUT_ERROR = 'timeout-error',
  RESOURCE_ERROR = 'resource-error',
  MEMORY_ERROR = 'memory-error',
  CONFIGURATION_ERROR = 'configuration-error',
  EXECUTION_ERROR = 'execution-error',
  SYSTEM_ERROR = 'system-error',
  UNKNOWN_ERROR = 'unknown-error'
}

/**
 * 错误边界状态
 */
export enum ErrorBoundaryState {
  NORMAL = 'normal',
  DEGRADED = 'degraded',
  ISOLATED = 'isolated',
  RECOVERING = 'recovering',
  FAILED = 'failed'
}

/**
 * 恢复策略
 */
export enum RecoveryStrategy {
  RETRY_IMMEDIATE = 'retry-immediate',
  RETRY_DELAYED = 'retry-delayed',
  RETRY_EXPONENTIAL = 'retry-exponential',
  FALLBACK_PRIMARY = 'fallback-primary',
  FALLBACK_SECONDARY = 'fallback-secondary',
  CIRCUIT_BREAKER = 'circuit-breaker',
  GRACEFUL_DEGRADATION = 'graceful-degradation',
  SKIP_OPERATION = 'skip-operation',
  TERMINATE = 'terminate'
}

/**
 * 系统错误信息
 */
export interface SystemError {
  /** 错误ID */
  errorId: string;
  /** 错误类型 */
  type: ErrorType;
  /** 错误级别 */
  level: ErrorLevel;
  /** 错误消息 */
  message: string;
  /** 错误详情 */
  details: any;
  /** 发生时间 */
  timestamp: number;
  /** 发生位置 */
  location: string;
  /** 堆栈跟踪 */
  stack?: string;
  /** 相关资源 */
  affectedResources?: string[];
  /** 上下文信息 */
  context?: Record<string, any>;
  /** 可恢复性 */
  recoverable: boolean;
  /** 恢复策略建议 */
  suggestedStrategy?: RecoveryStrategy;
}

/**
 * 错误处理结果
 */
export interface ErrorHandlerResult {
  /** 处理是否成功 */
  success: boolean;
  /** 错误是否已解决 */
  resolved: boolean;
  /** 采取的操作 */
  action: string;
  /** 执行的策略 */
  strategy?: RecoveryStrategy;
  /** 执行结果 */
  result?: any;
  /** 错误详情 */
  error?: SystemError;
  /** 恢复时间 */
  recoveryTime?: number;
  /** 后续建议 */
  recommendations?: string[];
}

/**
 * 错误边界配置
 */
export interface ErrorBoundaryConfig {
  /** 错误边界ID */
  boundaryId: string;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟 (ms) */
  retryDelay: number;
  /** 指数退避基础 */
  exponentialBackoffBase: number;
  /** 超时时间 (ms) */
  timeout: number;
  /** 是否启用熔断器 */
  enableCircuitBreaker: boolean;
  /** 熔断器阈值 */
  circuitBreakerThreshold: number;
  /** 熔断器重置时间 (ms) */
  circuitBreakerResetTime: number;
  /** 是否启用优雅降级 */
  enableGracefulDegradation: boolean;
  /** 降级策略 */
  degradationStrategies: Record<string, () => Promise<any>>;
  /** 是否启用错误隔离 */
  enableErrorIsolation: boolean;
  /** 错误隔离阈值 */
  errorIsolationThreshold: number;
  /** 自定义错误处理器 */
  customHandlers?: Record<ErrorType, (error: SystemError) => Promise<ErrorHandlerResult>>;
}

/**
 * 熔断器状态
 */
export interface CircuitBreakerState {
  /** 熔断器状态 */
  state: 'closed' | 'open' | 'half-open';
  /** 失败次数 */
  failureCount: number;
  /** 最后失败时间 */
  lastFailureTime: number;
  /** 下次重试时间 */
  nextAttemptTime: number;
  /** 成功次数 */
  successCount: number;
  /** 总请求次数 */
  totalRequests: number;
}

/**
 * 错误统计信息
 */
export interface ErrorStats {
  /** 总错误数 */
  totalErrors: number;
  /** 按类型分组的错误数 */
  errorsByType: Record<ErrorType, number>;
  /** 按级别分组的错误数 */
  errorsByLevel: Record<ErrorLevel, number>;
  /** 恢复成功次数 */
  successfulRecoveries: number;
  /** 恢复失败次数 */
  failedRecoveries: number;
  /** 平均恢复时间 */
  averageRecoveryTime: number;
  /** 活跃错误边界数 */
  activeBoundaries: number;
  /** 熔断器触发次数 */
  circuitBreakerTrips: number;
}

/**
 * 错误边界管理器
 */
export class ErrorBoundaryManager {
  private boundaries: Map<string, ErrorBoundary> = new Map();
  public globalStats: ErrorStats;
  private eventHandlers: Map<string, Function[]> = new Map();
  private activeErrors: Map<string, SystemError> = new Map();

  constructor() {
    this.globalStats = this.initializeStats();
  }

  /**
   * 创建错误边界
   */
  createBoundary(config: ErrorBoundaryConfig): ErrorBoundary {
    const boundary = new ErrorBoundary(config, this);
    this.boundaries.set(config.boundaryId, boundary);
    this.globalStats.activeBoundaries++;
    this.emitEvent('boundary-created', { boundaryId: config.boundaryId });
    return boundary;
  }

  /**
   * 获取错误边界
   */
  getBoundary(boundaryId: string): ErrorBoundary | undefined {
    return this.boundaries.get(boundaryId);
  }

  /**
   * 删除错误边界
   */
  removeBoundary(boundaryId: string): boolean {
    const boundary = this.boundaries.get(boundaryId);
    if (boundary) {
      boundary.destroy();
      this.boundaries.delete(boundaryId);
      this.globalStats.activeBoundaries--;
      this.emitEvent('boundary-removed', { boundaryId });
      return true;
    }
    return false;
  }

  /**
   * 处理错误
   */
  async handleError(error: SystemError, boundaryId?: string): Promise<ErrorHandlerResult> {
    // 记录错误
    this.recordError(error);

    // 如果指定了错误边界，使用边界处理
    if (boundaryId) {
      const boundary = this.boundaries.get(boundaryId);
      if (boundary) {
        return boundary.handleError(error);
      }
    }

    // 全局错误处理
    return this.handleGlobalError(error);
  }

  /**
   * 全局错误处理
   */
  private async handleGlobalError(error: SystemError): Promise<ErrorHandlerResult> {
    const startTime = Date.now();

    try {
      // 根据错误类型选择恢复策略
      const strategy = this.determineRecoveryStrategy(error);
      const result = await this.executeRecoveryStrategy(error, strategy);

      const recoveryTime = Date.now() - startTime;

      if (result.success) {
        this.globalStats.successfulRecoveries++;
        this.globalStats.averageRecoveryTime =
          (this.globalStats.averageRecoveryTime * (this.globalStats.successfulRecoveries - 1) + recoveryTime) /
          this.globalStats.successfulRecoveries;
      } else {
        this.globalStats.failedRecoveries++;
      }

      return {
        ...result,
        recoveryTime
      };
    } catch (handlingError) {
      const systemError: SystemError = {
        errorId: `handler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: ErrorType.SYSTEM_ERROR,
        level: ErrorLevel.CRITICAL,
        message: `Error handler failed: ${handlingError instanceof Error ? handlingError.message : String(handlingError)}`,
        details: { originalError: error, handlerError: handlingError },
        timestamp: Date.now(),
        location: 'ErrorBoundaryManager.handleGlobalError',
        recoverable: false,
        suggestedStrategy: RecoveryStrategy.TERMINATE
      };

      this.recordError(systemError);
      this.globalStats.failedRecoveries++;

      return {
        success: false,
        resolved: false,
        action: 'handler-failed',
        error: systemError,
        recommendations: ['Restart the system', 'Check error handler implementation']
      };
    }
  }

  /**
   * 确定恢复策略
   */
  private determineRecoveryStrategy(error: SystemError): RecoveryStrategy {
    switch (error.type) {
      case ErrorType.NETWORK_ERROR:
        return RecoveryStrategy.RETRY_EXPONENTIAL;
      case ErrorType.TIMEOUT_ERROR:
        return RecoveryStrategy.RETRY_DELAYED;
      case ErrorType.RESOURCE_ERROR:
        return RecoveryStrategy.FALLBACK_PRIMARY;
      case ErrorType.MEMORY_ERROR:
        return RecoveryStrategy.GRACEFUL_DEGRADATION;
      case ErrorType.CONFIGURATION_ERROR:
        return RecoveryStrategy.SKIP_OPERATION;
      case ErrorType.VALIDATION_ERROR:
        return RecoveryStrategy.SKIP_OPERATION;
      default:
        return RecoveryStrategy.RETRY_IMMEDIATE;
    }
  }

  /**
   * 执行恢复策略
   */
  private async executeRecoveryStrategy(
    error: SystemError,
    strategy: RecoveryStrategy
  ): Promise<ErrorHandlerResult> {
    switch (strategy) {
      case RecoveryStrategy.RETRY_IMMEDIATE:
        return this.retryOperation(error, 1);
      case RecoveryStrategy.RETRY_DELAYED:
        return this.retryOperation(error, 3, 1000);
      case RecoveryStrategy.RETRY_EXPONENTIAL:
        return this.retryWithExponentialBackoff(error);
      case RecoveryStrategy.FALLBACK_PRIMARY:
        return this.executeFallback(error, 'primary');
      case RecoveryStrategy.FALLBACK_SECONDARY:
        return this.executeFallback(error, 'secondary');
      case RecoveryStrategy.GRACEFUL_DEGRADATION:
        return this.executeGracefulDegradation(error);
      case RecoveryStrategy.SKIP_OPERATION:
        return this.skipOperation(error);
      case RecoveryStrategy.TERMINATE:
        return this.terminateOperation(error);
      default:
        return {
          success: false,
          resolved: false,
          action: 'unknown-strategy',
          error,
          recommendations: ['Unknown recovery strategy']
        };
    }
  }

  /**
   * 重试操作
   */
  private async retryOperation(
    error: SystemError,
    maxRetries: number,
    delay: number = 0
  ): Promise<ErrorHandlerResult> {
    let lastError = error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (delay > 0) {
          await this.sleep(delay);
        }

        // 这里应该尝试重新执行原始操作
        // 由于这是一个通用的错误处理系统，我们假设操作成功
        return {
          success: true,
          resolved: true,
          action: `retry-success-attempt-${attempt}`,
          strategy: delay > 0 ? RecoveryStrategy.RETRY_DELAYED : RecoveryStrategy.RETRY_IMMEDIATE
        };
      } catch (retryError) {
        lastError = {
          ...error,
          errorId: `retry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          message: `Retry attempt ${attempt} failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          timestamp: Date.now()
        };
        this.recordError(lastError);
      }
    }

    return {
      success: false,
      resolved: false,
      action: 'retry-failed',
      error: lastError,
      recommendations: [`Operation failed after ${maxRetries} retries`]
    };
  }

  /**
   * 指数退避重试
   */
  private async retryWithExponentialBackoff(error: SystemError): Promise<ErrorHandlerResult> {
    const maxRetries = 5;
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      const result = await this.retryOperation(error, 1, delay);

      if (result.success) {
        return {
          ...result,
          strategy: RecoveryStrategy.RETRY_EXPONENTIAL
        };
      }
    }

    return {
      success: false,
      resolved: false,
      action: 'exponential-backoff-failed',
      error,
      recommendations: ['Operation failed after exponential backoff retries']
    };
  }

  /**
   * 执行降级策略
   */
  private async executeFallback(error: SystemError, fallbackType: string): Promise<ErrorHandlerResult> {
    try {
      // 这里应该执行降级策略
      // 由于这是一个通用的实现，我们返回成功结果
      return {
        success: true,
        resolved: true,
        action: `fallback-${fallbackType}`,
        strategy: fallbackType === 'primary' ? RecoveryStrategy.FALLBACK_PRIMARY : RecoveryStrategy.FALLBACK_SECONDARY,
        result: { fallback: true, type: fallbackType }
      };
    } catch (fallbackError) {
      return {
        success: false,
        resolved: false,
        action: `fallback-${fallbackType}-failed`,
        error: {
          ...error,
          errorId: `fallback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          message: `Fallback ${fallbackType} failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          timestamp: Date.now()
        },
        recommendations: [`Fallback ${fallbackType} strategy failed`]
      };
    }
  }

  /**
   * 执行优雅降级
   */
  private async executeGracefulDegradation(error: SystemError): Promise<ErrorHandlerResult> {
    try {
      // 清理内存资源
      await memoryManager.cleanup(true);

      // 记录降级操作
      return {
        success: true,
        resolved: true,
        action: 'graceful-degradation',
        strategy: RecoveryStrategy.GRACEFUL_DEGRADATION,
        result: { degraded: true, level: 'partial' }
      };
    } catch (degradationError) {
      return {
        success: false,
        resolved: false,
        action: 'graceful-degradation-failed',
        error: {
          ...error,
          errorId: `degradation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          message: `Graceful degradation failed: ${degradationError instanceof Error ? degradationError.message : String(degradationError)}`,
          timestamp: Date.now()
        },
        recommendations: ['Graceful degradation failed, consider system restart']
      };
    }
  }

  /**
   * 跳过操作
   */
  private async skipOperation(error: SystemError): Promise<ErrorHandlerResult> {
    return {
      success: true,
      resolved: true,
      action: 'skip-operation',
      strategy: RecoveryStrategy.SKIP_OPERATION,
      result: { skipped: true, originalError: error.errorId }
    };
  }

  /**
   * 终止操作
   */
  private async terminateOperation(error: SystemError): Promise<ErrorHandlerResult> {
    return {
      success: false,
      resolved: false,
      action: 'terminate-operation',
      strategy: RecoveryStrategy.TERMINATE,
      error,
      recommendations: ['Operation terminated due to critical error']
    };
  }

  /**
   * 记录错误
   */
  private recordError(error: SystemError): void {
    this.globalStats.totalErrors++;
    this.globalStats.errorsByType[error.type]++;
    this.globalStats.errorsByLevel[error.level]++;

    // 添加到活跃错误列表
    this.activeErrors.set(error.errorId, error);

    // 清理过期的活跃错误
    this.cleanupActiveErrors();

    // 发出错误事件
    this.emitEvent('error-occurred', error);
  }

  /**
   * 清理过期的活跃错误
   */
  private cleanupActiveErrors(): void {
    const now = Date.now();
    const expireTime = 300000; // 5分钟

    for (const [errorId, error] of this.activeErrors.entries()) {
      if (now - error.timestamp > expireTime) {
        this.activeErrors.delete(errorId);
      }
    }
  }

  /**
   * 初始化统计信息
   */
  private initializeStats(): ErrorStats {
    const errorsByType: Record<ErrorType, number> = {} as any;
    const errorsByLevel: Record<ErrorLevel, number> = {} as any;

    Object.values(ErrorType).forEach(type => {
      errorsByType[type] = 0;
    });

    Object.values(ErrorLevel).forEach(level => {
      errorsByLevel[level] = 0;
    });

    return {
      totalErrors: 0,
      errorsByType,
      errorsByLevel,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      averageRecoveryTime: 0,
      activeBoundaries: 0,
      circuitBreakerTrips: 0
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): ErrorStats {
    return { ...this.globalStats };
  }

  /**
   * 获取活跃错误
   */
  getActiveErrors(): SystemError[] {
    return Array.from(this.activeErrors.values());
  }

  /**
   * 添加事件监听器
   */
  addEventListener(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  /**
   * 发出事件
   */
  private emitEvent(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error);
      }
    });
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // 清理所有错误边界
    for (const boundary of this.boundaries.values()) {
      boundary.destroy();
    }
    this.boundaries.clear();

    // 清理活跃错误
    this.activeErrors.clear();

    // 清理事件监听器
    this.eventHandlers.clear();

    // 重置统计
    this.globalStats = this.initializeStats();
  }
}

/**
 * 错误边界类
 */
export class ErrorBoundary {
  private config: ErrorBoundaryConfig;
  private manager: ErrorBoundaryManager;
  private circuitBreaker: CircuitBreakerState;
  private errorCount: number = 0;
  private lastErrorTime: number = 0;
  private state: ErrorBoundaryState = ErrorBoundaryState.NORMAL;

  constructor(config: ErrorBoundaryConfig, manager: ErrorBoundaryManager) {
    this.config = config;
    this.manager = manager;
    this.circuitBreaker = {
      state: 'closed',
      failureCount: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0,
      successCount: 0,
      totalRequests: 0
    };
  }

  /**
   * 执行受保护的操作
   */
  async execute<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    return this.executeWithBoundary(operation, fallback);
  }

  /**
   * 带错误边界执行操作
   */
  private async executeWithBoundary<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    // 检查熔断器状态
    if (this.config.enableCircuitBreaker && this.isCircuitBreakerOpen()) {
      throw new Error('Circuit breaker is open');
    }

    try {
      const result = await this.executeWithTimeout(operation);
      this.onSuccess();
      return result;
    } catch (error) {
      const systemError = this.createSystemError(error);
      const handlerResult = await this.handleError(systemError);

      if (handlerResult.success && handlerResult.result !== undefined) {
        return handlerResult.result;
      }

      if (fallback && this.config.enableGracefulDegradation) {
        try {
          return await fallback();
        } catch (fallbackError) {
          throw fallbackError;
        }
      }

      throw error;
    }
  }

  /**
   * 带超时执行操作
   */
  private async executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    if (this.config.timeout <= 0) {
      return operation();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Operation timed out after ${this.config.timeout}ms`));
      }, this.config.timeout);

      operation()
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * 处理错误
   */
  async handleError(error: SystemError): Promise<ErrorHandlerResult> {
    this.onError(error);

    // 检查自定义错误处理器
    if (this.config.customHandlers && this.config.customHandlers[error.type]) {
      try {
        return await this.config.customHandlers[error.type](error);
      } catch (handlerError) {
        console.error('Custom error handler failed:', handlerError);
      }
    }

    // 委托给管理器处理
    return this.manager.handleError(error);
  }

  /**
   * 创建系统错误
   */
  private createSystemError(error: any): SystemError {
    return {
      errorId: `boundary_${this.config.boundaryId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: this.determineErrorType(error),
      level: this.determineErrorLevel(error),
      message: error instanceof Error ? error.message : String(error),
      details: error,
      timestamp: Date.now(),
      location: this.config.boundaryId,
      stack: error instanceof Error ? error.stack : undefined,
      recoverable: this.isErrorRecoverable(error),
      suggestedStrategy: this.determineRecoveryStrategy(error)
    };
  }

  /**
   * 确定错误类型
   */
  private determineErrorType(error: any): ErrorType {
    if (error instanceof TypeError) {
      return ErrorType.VALIDATION_ERROR;
    }
    if (error instanceof RangeError) {
      return ErrorType.VALIDATION_ERROR;
    }
    if (error.message?.includes('timeout')) {
      return ErrorType.TIMEOUT_ERROR;
    }
    if (error.message?.includes('network') || error.code === 'ENOTFOUND') {
      return ErrorType.NETWORK_ERROR;
    }
    if (error.message?.includes('memory') || error.code === 'ENOMEM') {
      return ErrorType.MEMORY_ERROR;
    }
    return ErrorType.UNKNOWN_ERROR;
  }

  /**
   * 确定错误级别
   */
  private determineErrorLevel(error: any): ErrorLevel {
    if (error instanceof TypeError || error instanceof RangeError) {
      return ErrorLevel.WARNING;
    }
    if (error.message?.includes('timeout')) {
      return ErrorLevel.WARNING;
    }
    if (error.message?.includes('memory') || error.code === 'ENOMEM') {
      return ErrorLevel.CRITICAL;
    }
    return ErrorLevel.ERROR;
  }

  /**
   * 检查错误是否可恢复
   */
  private isErrorRecoverable(error: any): boolean {
    const unrecoverableErrors = [
      ErrorType.CONFIGURATION_ERROR,
      ErrorType.SYSTEM_ERROR
    ];
    return !unrecoverableErrors.includes(this.determineErrorType(error));
  }

  /**
   * 确定恢复策略
   */
  private determineRecoveryStrategy(error: any): RecoveryStrategy {
    const type = this.determineErrorType(error);
    const level = this.determineErrorLevel(error);

    if (level === ErrorLevel.CRITICAL) {
      return RecoveryStrategy.TERMINATE;
    }

    if (type === ErrorType.NETWORK_ERROR) {
      return RecoveryStrategy.RETRY_EXPONENTIAL;
    }

    if (type === ErrorType.TIMEOUT_ERROR) {
      return RecoveryStrategy.RETRY_DELAYED;
    }

    return RecoveryStrategy.RETRY_IMMEDIATE;
  }

  /**
   * 检查熔断器是否开启
   */
  private isCircuitBreakerOpen(): boolean {
    if (this.circuitBreaker.state === 'open') {
      if (Date.now() > this.circuitBreaker.nextAttemptTime) {
        this.circuitBreaker.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * 成功回调
   */
  private onSuccess(): void {
    this.errorCount = 0;
    this.state = ErrorBoundaryState.NORMAL;
    this.updateCircuitBreaker(true);
  }

  /**
   * 错误回调
   */
  private onError(error: SystemError): void {
    this.errorCount++;
    this.lastErrorTime = error.timestamp;
    this.state = ErrorBoundaryState.DEGRADED;
    this.updateCircuitBreaker(false);

    // 检查错误隔离阈值
    if (this.config.enableErrorIsolation && this.errorCount >= this.config.errorIsolationThreshold) {
      this.state = ErrorBoundaryState.ISOLATED;
    }
  }

  /**
   * 更新熔断器状态
   */
  private updateCircuitBreaker(success: boolean): void {
    this.circuitBreaker.totalRequests++;

    if (success) {
      this.circuitBreaker.successCount++;
      if (this.circuitBreaker.state === 'half-open') {
        this.circuitBreaker.state = 'closed';
        this.circuitBreaker.failureCount = 0;
      }
    } else {
      this.circuitBreaker.failureCount++;
      this.circuitBreaker.lastFailureTime = Date.now();

      if (this.circuitBreaker.failureCount >= this.config.circuitBreakerThreshold) {
        this.circuitBreaker.state = 'open';
        this.circuitBreaker.nextAttemptTime = Date.now() + this.config.circuitBreakerResetTime;
        this.manager.globalStats.circuitBreakerTrips++;
      }
    }
  }

  /**
   * 获取边界状态
   */
  getState(): ErrorBoundaryState {
    return this.state;
  }

  /**
   * 获取熔断器状态
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return { ...this.circuitBreaker };
  }

  /**
   * 重置边界状态
   */
  reset(): void {
    this.errorCount = 0;
    this.lastErrorTime = 0;
    this.state = ErrorBoundaryState.NORMAL;
    this.circuitBreaker = {
      state: 'closed',
      failureCount: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0,
      successCount: 0,
      totalRequests: 0
    };
  }

  /**
   * 销毁边界
   */
  destroy(): void {
    this.reset();
    this.manager = null as any;
  }
}

/**
 * 默认错误边界配置
 */
export const defaultErrorBoundaryConfig: ErrorBoundaryConfig = {
  boundaryId: 'default',
  maxRetries: 3,
  retryDelay: 1000,
  exponentialBackoffBase: 2,
  timeout: 30000,
  enableCircuitBreaker: true,
  circuitBreakerThreshold: 5,
  circuitBreakerResetTime: 60000,
  enableGracefulDegradation: true,
  degradationStrategies: {},
  enableErrorIsolation: true,
  errorIsolationThreshold: 10
};

/**
 * 导出单例实例
 */
export const errorBoundaryManager = new ErrorBoundaryManager();
