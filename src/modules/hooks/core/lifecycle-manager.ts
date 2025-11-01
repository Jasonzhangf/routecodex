/**
 * Hook系统生命周期管理器
 *
 * 负责Hook系统的初始化、启动、暂停、停止和清理
 * 提供状态监控、健康检查和优雅关闭功能
 */

import type {
  ILifecycleManager,
  HookSystemState,
  IHookManager,
  HookError,
  HookErrorType
} from '../types/hook-types.js';

/**
 * 生命周期管理器实现
 */
export class LifecycleManager implements ILifecycleManager {
  private currentState: HookSystemState = HookSystemState.UNINITIALIZED;
  private stateChangeCallbacks: Array<(oldState: HookSystemState, newState: HookSystemState) => void> = [];
  private hookManager?: IHookManager;
  private cleanupTasks: Array<() => Promise<void>> = [];
  private isShuttingDown = false;

  constructor() {
    // 注册进程退出处理
    this.setupGracefulShutdown();
  }

  /**
   * 初始化Hook系统
   */
  async initialize(): Promise<void> {
    if (this.currentState !== HookSystemState.UNINITIALIZED) {
      throw new Error(`Cannot initialize in state: ${this.currentState}`);
    }

    try {
      this.setState(HookSystemState.INITIALIZING);

      // 初始化Hook管理器
      if (this.hookManager) {
        await this.initializeHookManager();
      }

      // 执行自定义初始化任务
      await this.executeInitializationTasks();

      this.setState(HookSystemState.RUNNING);
      console.log('Hook system initialized successfully');
    } catch (error) {
      this.setState(HookSystemState.ERROR);
      const hookError: HookError = {
        type: HookErrorType.LIFECYCLE_ERROR,
        message: 'Failed to initialize hook system',
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now()
      };
      this.handleError(hookError);
      throw error;
    }
  }

  /**
   * 启动Hook系统
   */
  async start(): Promise<void> {
    if (this.currentState === HookSystemState.UNINITIALIZED) {
      await this.initialize();
      return;
    }

    if (this.currentState !== HookSystemState.PAUSED && this.currentState !== HookSystemState.STOPPED) {
      throw new Error(`Cannot start in state: ${this.currentState}`);
    }

    try {
      this.setState(HookSystemState.RUNNING);

      // 启动Hook管理器
      if (this.hookManager) {
        await this.startHookManager();
      }

      // 执行启动任务
      await this.executeStartupTasks();

      console.log('Hook system started successfully');
    } catch (error) {
      this.setState(HookSystemState.ERROR);
      const hookError: HookError = {
        type: HookErrorType.LIFECYCLE_ERROR,
        message: 'Failed to start hook system',
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now()
      };
      this.handleError(hookError);
      throw error;
    }
  }

  /**
   * 暂停Hook系统
   */
  async pause(): Promise<void> {
    if (this.currentState !== HookSystemState.RUNNING) {
      throw new Error(`Cannot pause in state: ${this.currentState}`);
    }

    try {
      this.setState(HookSystemState.PAUSED);

      // 执行暂停任务
      await this.executePauseTasks();

      console.log('Hook system paused successfully');
    } catch (error) {
      this.setState(HookSystemState.ERROR);
      const hookError: HookError = {
        type: HookErrorType.LIFECYCLE_ERROR,
        message: 'Failed to pause hook system',
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now()
      };
      this.handleError(hookError);
      throw error;
    }
  }

  /**
   * 停止Hook系统
   */
  async stop(): Promise<void> {
    if (this.currentState === HookSystemState.UNINITIALIZED ||
        this.currentState === HookSystemState.STOPPED ||
        this.currentState === HookSystemState.STOPPING) {
      return;
    }

    try {
      this.setState(HookSystemState.STOPPING);

      // 执行停止任务
      await this.executeStopTasks();

      this.setState(HookSystemState.STOPPED);
      console.log('Hook system stopped successfully');
    } catch (error) {
      this.setState(HookSystemState.ERROR);
      const hookError: HookError = {
        type: HookErrorType.LIFECYCLE_ERROR,
        message: 'Failed to stop hook system',
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now()
      };
      this.handleError(hookError);
      throw error;
    }
  }

  /**
   * 关闭Hook系统（完全清理）
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    try {
      // 先停止系统
      if (this.currentState !== HookSystemState.STOPPED) {
        await this.stop();
      }

      this.setState(HookSystemState.STOPPING);

      // 执行关闭任务
      await this.executeShutdownTasks();

      // 执行清理任务
      await this.executeCleanupTasks();

      this.setState(HookSystemState.STOPPED);
      console.log('Hook system shutdown successfully');
    } catch (error) {
      this.setState(HookSystemState.ERROR);
      const hookError: HookError = {
        type: HookErrorType.LIFECYCLE_ERROR,
        message: 'Failed to shutdown hook system',
        cause: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now()
      };
      this.handleError(hookError);
      throw error;
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * 获取当前状态
   */
  getState(): HookSystemState {
    return this.currentState;
  }

  /**
   * 监听状态变化
   */
  onStateChange(callback: (oldState: HookSystemState, newState: HookSystemState) => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  /**
   * 设置Hook管理器
   */
  setHookManager(hookManager: IHookManager): void {
    this.hookManager = hookManager;
  }

  /**
   * 注册清理任务
   */
  registerCleanupTask(task: () => Promise<void>): void {
    this.cleanupTasks.push(task);
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    state: HookSystemState;
    issues: string[];
    checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message?: string }>;
  }> {
    const issues: string[] = [];
    const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message?: string }> = [];

    // 检查系统状态
    const validStates = [HookSystemState.RUNNING, HookSystemState.PAUSED, HookSystemState.STOPPED];
    if (!validStates.includes(this.currentState)) {
      issues.push(`Invalid system state: ${this.currentState}`);
      checks.push({ name: 'system-state', status: 'fail', message: `State: ${this.currentState}` });
    } else {
      checks.push({ name: 'system-state', status: 'pass' });
    }

    // 检查Hook管理器
    if (this.hookManager) {
      try {
        const managerHealth = await (this.hookManager as any).healthCheck?.();
        if (managerHealth) {
          if (managerHealth.healthy) {
            checks.push({ name: 'hook-manager', status: 'pass' });
          } else {
            issues.push(...managerHealth.issues);
            checks.push({
              name: 'hook-manager',
              status: 'fail',
              message: managerHealth.issues.join(', ')
            });
          }
        } else {
          checks.push({ name: 'hook-manager', status: 'pass' });
        }
      } catch (error) {
        issues.push('Hook manager health check failed');
        checks.push({
          name: 'hook-manager',
          status: 'fail',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      checks.push({ name: 'hook-manager', status: 'warn', message: 'No hook manager configured' });
    }

    // 检查清理任务
    if (this.cleanupTasks.length > 50) {
      issues.push(`Too many cleanup tasks registered: ${this.cleanupTasks.length}`);
      checks.push({
        name: 'cleanup-tasks',
        status: 'warn',
        message: `${this.cleanupTasks.length} tasks`
      });
    } else {
      checks.push({ name: 'cleanup-tasks', status: 'pass' });
    }

    return {
      healthy: issues.length === 0,
      state: this.currentState,
      issues,
      checks
    };
  }

  /**
   * 设置状态
   */
  private setState(newState: HookSystemState): void {
    const oldState = this.currentState;
    this.currentState = newState;

    // 通知状态变化监听器
    this.stateChangeCallbacks.forEach(callback => {
      try {
        callback(oldState, newState);
      } catch (error) {
        console.error('Error in state change callback:', error);
      }
    });

    console.log(`Hook system state changed: ${oldState} -> ${newState}`);
  }

  /**
   * 初始化Hook管理器
   */
  private async initializeHookManager(): Promise<void> {
    if (!this.hookManager) {
      return;
    }

    // 这里可以执行Hook管理器的特定初始化逻辑
    // 例如：加载配置、建立连接等
  }

  /**
   * 启动Hook管理器
   */
  private async startHookManager(): Promise<void> {
    if (!this.hookManager) {
      return;
    }

    // 这里可以执行Hook管理器的特定启动逻辑
    // 例如：启动后台任务、注册监听器等
  }

  /**
   * 执行初始化任务
   */
  private async executeInitializationTasks(): Promise<void> {
    // 预留给未来的初始化任务
    // 例如：加载配置文件、建立数据库连接等
  }

  /**
   * 执行启动任务
   */
  private async executeStartupTasks(): Promise<void> {
    // 预留给未来的启动任务
    // 例如：启动定时任务、注册事件监听器等
  }

  /**
   * 执行暂停任务
   */
  private async executePauseTasks(): Promise<void> {
    // 预留给未来的暂停任务
    // 例如：暂停定时任务、停止接收新请求等
  }

  /**
   * 执行停止任务
   */
  private async executeStopTasks(): Promise<void> {
    // 预留给未来的停止任务
    // 例如：停止定时任务、完成正在处理的请求等
  }

  /**
   * 执行关闭任务
   */
  private async executeShutdownTasks(): Promise<void> {
    // 预留给未来的关闭任务
    // 例如：关闭网络连接、释放资源等
  }

  /**
   * 执行清理任务
   */
  private async executeCleanupTasks(): Promise<void> {
    const cleanupPromises = this.cleanupTasks.map(async (task, index) => {
      try {
        await task();
      } catch (error) {
        console.error(`Cleanup task ${index} failed:`, error);
      }
    });

    await Promise.allSettled(cleanupPromises);
    this.cleanupTasks = [];
  }

  /**
   * 处理错误
   */
  private handleError(error: HookError): void {
    console.error('Lifecycle manager error:', {
      type: error.type,
      message: error.message,
      timestamp: error.timestamp,
      cause: error.cause
    });

    // 这里可以集成错误报告服务
    // 例如：errorReporter.report(error);
  }

  /**
   * 设置优雅关闭
   */
  private setupGracefulShutdown(): void {
    const shutdownSignals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];

    shutdownSignals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`Received ${signal}, starting graceful shutdown...`);
        try {
          await this.shutdown();
          process.exit(0);
        } catch (error) {
          console.error('Error during graceful shutdown:', error);
          process.exit(1);
        }
      });
    });

    // 处理未捕获的异常
    process.on('uncaughtException', async (error) => {
      console.error('Uncaught exception:', error);
      try {
        await this.shutdown();
      } catch (shutdownError) {
        console.error('Error during shutdown after uncaught exception:', shutdownError);
      }
      process.exit(1);
    });

    // 处理未处理的Promise rejection
    process.on('unhandledRejection', async (reason, promise) => {
      console.error('Unhandled rejection at:', promise, 'reason:', reason);
      try {
        await this.shutdown();
      } catch (shutdownError) {
        console.error('Error during shutdown after unhandled rejection:', shutdownError);
      }
      process.exit(1);
    });
  }

  /**
   * 获取系统信息
   */
  getSystemInfo(): {
    state: HookSystemState;
    uptime: number;
    registeredCallbacks: number;
    cleanupTasks: number;
    isShuttingDown: boolean;
  } {
    // 计算运行时间（简单实现，实际中应该记录启动时间）
    const uptime = this.currentState !== HookSystemState.UNINITIALIZED ? Date.now() : 0;

    return {
      state: this.currentState,
      uptime,
      registeredCallbacks: this.stateChangeCallbacks.length,
      cleanupTasks: this.cleanupTasks.length,
      isShuttingDown: this.isShuttingDown
    };
  }
}

/**
 * 生命周期管理器工厂
 */
export class LifecycleManagerFactory {
  /**
   * 创建默认生命周期管理器
   */
  static createDefault(): LifecycleManager {
    return new LifecycleManager();
  }

  /**
   * 创建带配置的生命周期管理器
   */
  static createWithConfig(config: {
    enableGracefulShutdown?: boolean;
    shutdownTimeout?: number;
    maxCleanupTasks?: number;
  }): LifecycleManager {
    const manager = new LifecycleManager();

    // 配置清理任务数量限制
    if (config.maxCleanupTasks) {
      // 这里可以在LifecycleManager中添加配置逻辑
    }

    return manager;
  }
}