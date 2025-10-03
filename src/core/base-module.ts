import { EventEmitter } from 'events';
import * as debugcenter from 'rcc-debugcenter';
import { BaseModule as RCCBaseModule, type ModuleInfo } from 'rcc-basemodule';
import { DebugEnhancementManager } from '../modules/debug/debug-enhancement-manager.js';

export type { ModuleInfo } from 'rcc-basemodule';

const DebugCenter =
  (debugcenter as any).DebugCenter ||
  class {
    constructor() {}
  };

const DebugEventBus =
  (debugcenter as any).DebugEventBus ||
  class {
    static getInstance() {
      return {
        publish: () => {},
      };
    }
  };

type DebugEventBusInstance = ReturnType<(typeof DebugEventBus)['getInstance']>;

/**
 * 模块状态枚举
 */
export enum ModuleStatus {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  ERROR = 'error',
}

/**
 * RouteCodex Base Module
 *
 * Wraps the upstream RCC BaseModule while preserving the
 * RouteCodex-specific debug and lifecycle helpers that other modules rely on.
 */
export abstract class BaseModule extends RCCBaseModule {
  protected status: ModuleStatus = ModuleStatus.STOPPED;
  private runningState = false;

  // Unified debug enhancement properties
  private debugEnhancementManager: DebugEnhancementManager | null = null;
  private debugEnhancement: any = null;

  // Legacy debug properties for backward compatibility
  protected debugEventBus: DebugEventBusInstance | null = null;
  public isDebugEnhanced = false;
  public moduleMetrics: Map<string, any> = new Map();
  public operationHistory: any[] = [];
  public errorHistory: any[] = [];
  public maxHistorySize = 50;

  private readonly emitter = new EventEmitter();

  constructor(info: ModuleInfo) {
    super(info);
    this.initializeUnifiedDebugEnhancements();
    this.initializeDebugEnhancements();
  }

  /**
   * 订阅事件
   */
  public on(event: string | symbol, listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  /**
   * 订阅一次性事件
   */
  public once(event: string | symbol, listener: (...args: any[]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  /**
   * 取消事件订阅
   */
  public off(event: string | symbol, listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  /**
   * 发射事件
   */
  protected emit(event: string | symbol, ...args: any[]): boolean {
    return this.emitter.emit(event, ...args);
  }

  /**
   * 获取模块信息
   */
  public override getInfo(): ModuleInfo {
    return super.getInfo();
  }

  /**
   * 获取模块状态
   */
  getStatus(): ModuleStatus {
    return this.status;
  }

  /**
   * 检查模块是否运行中
   */
  isModuleRunning(): boolean {
    return this.isRunning();
  }

  public override isRunning(): boolean {
    return this.runningState;
  }

  /**
   * 初始化模块 - 子类必须实现
   */
  abstract initialize(config?: any): Promise<void>;

  /**
   * 启动模块
   */
  async start(): Promise<void> {
    if (this.runningState) {
      const info = this.getInfo();
      console.warn(`Module ${info.id} is already running`);
      return;
    }

    try {
      const info = this.getInfo();
      this.status = ModuleStatus.STARTING;
      this.emit('starting', info);

      await this.doStart();

      this.status = ModuleStatus.RUNNING;
      this.runningState = true;
      this.emit('started', info);

      console.log(`✅ Module ${info.id} started successfully`);
    } catch (error) {
      const info = this.getInfo();
      this.status = ModuleStatus.ERROR;
      this.emit('error', { module: info, error });
      throw error;
    }
  }

  /**
   * 停止模块
   */
  async stop(): Promise<void> {
    if (!this.runningState) {
      const info = this.getInfo();
      console.warn(`Module ${info.id} is not running`);
      return;
    }

    try {
      const info = this.getInfo();
      this.status = ModuleStatus.STOPPING;
      this.emit('stopping', info);

      await this.doStop();

      this.status = ModuleStatus.STOPPED;
      this.runningState = false;
      this.emit('stopped', info);

      console.log(`🛑 Module ${info.id} stopped successfully`);
    } catch (error) {
      const info = this.getInfo();
      this.status = ModuleStatus.ERROR;
      this.emit('error', { module: info, error });
      throw error;
    }
  }

  /**
   * 重启模块
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * 获取模块统计信息
   */
  getStats(): any {
    const info = this.getInfo();
    return {
      id: info.id,
      name: info.name,
      version: info.version,
      status: this.status,
      isRunning: this.runningState,
      uptime: this.runningState ? Date.now() - this.getStartTime() : 0,
    };
  }

  /**
   * 启动逻辑 - 子类可以重写
   */
  protected async doStart(): Promise<void> {
    // 默认实现：子类可以重写此方法
  }

  /**
   * 停止逻辑 - 子类可以重写
   */
  protected async doStop(): Promise<void> {
    // 默认实现：子类可以重写此方法
  }

  /**
   * 获取启动时间
   */
  private getStartTime(): number {
    return Date.now();
  }

  /**
   * 处理模块错误
   */
  protected handleError(error: Error, context?: string): void {
    const info = this.getInfo();
    this.emit('error', {
      module: info,
      error,
      context,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Initialize unified debug enhancements
   */
  private initializeUnifiedDebugEnhancements(): void {
    const info = this.getInfo();
    try {
      const debugCenter = new DebugCenter();
      this.debugEnhancementManager = DebugEnhancementManager.getInstance(debugCenter);
      this.debugEnhancement = this.debugEnhancementManager.registerEnhancement(info.id, {
        enabled: true,
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        maxHistorySize: this.maxHistorySize,
      });

      console.log(`BaseModule unified debug enhancements initialized for ${info.id}`);
    } catch (error) {
      console.warn(`Failed to initialize BaseModule unified debug enhancements for ${info.id}:`, error);
      this.debugEnhancementManager = null;
    }
  }

  /**
   * Initialize debug enhancements
   */
  public initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
      console.log('BaseModule debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize BaseModule debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }

  /**
   * Record module metric - unified approach
   */
  public recordModuleMetric(operation: string, data: any): void {
    const info = this.getInfo();
    if (this.debugEnhancement?.recordMetric) {
      this.debugEnhancement.recordMetric(operation, Date.now(), {
        moduleId: info.id,
        operation,
      });
    }

    if (!this.moduleMetrics.has(operation)) {
      this.moduleMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now(),
      });
    }

    const metric = this.moduleMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to operation history - unified approach
   */
  public addToOperationHistory(operation: any): void {
    const info = this.getInfo();
    if (this.debugEnhancement?.addRequestToHistory) {
      this.debugEnhancement.addRequestToHistory({
        ...operation,
        moduleId: info.id,
        type: 'operation',
      });
    }

    this.operationHistory.push(operation);
    if (this.operationHistory.length > this.maxHistorySize) {
      this.operationHistory.shift();
    }
  }

  /**
   * Add to error history - unified approach
   */
  public addToErrorHistory(error: any, metadata: Record<string, any> = {}): void {
    const info = this.getInfo();
    if (this.debugEnhancement?.addErrorToHistory) {
      this.debugEnhancement.addErrorToHistory({
        ...error,
        ...metadata,
        moduleId: info.id,
        timestamp: Date.now(),
      });
    }

    this.errorHistory.push(error);
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  public publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {
      return;
    }

    const info = this.getInfo();
    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: info.id,
        operationId: type,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          ...data,
          moduleId: info.id,
          source: 'base-module',
        },
      });
    } catch {
      // Ignore debug event publication failures
    }
  }

  /**
   * Get debug status with enhanced information - unified approach
   */
  getDebugStatus(): any {
    const info = this.getInfo();
    const baseStatus = {
      moduleId: info.id,
      name: info.name,
      version: info.version,
      status: this.status,
      isRunning: this.runningState,
      isEnhanced: this.isDebugEnhanced,
    };

    if (this.debugEnhancementManager) {
      return {
        ...baseStatus,
        unifiedDebugInfo: this.debugEnhancementManager.getSystemDebugStatus(),
        enhancementInfo: this.debugEnhancement
          ? {
              isActive: this.debugEnhancement.isActive,
              metricsCount: this.debugEnhancement.metrics.size,
              requestHistoryCount: this.debugEnhancement.requestHistory.length,
              errorHistoryCount: this.debugEnhancement.errorHistory.length,
            }
          : null,
      };
    }

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      moduleMetrics: this.getModuleMetrics(),
      operationHistory: [...this.operationHistory.slice(-10)],
      errorHistory: [...this.errorHistory.slice(-10)],
    };
  }

  /**
   * Get detailed debug information
   */
  public getDebugInfo(): any {
    const info = this.getInfo();
    return {
      moduleId: info.id,
      name: info.name,
      version: info.version,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      operationHistorySize: this.operationHistory.length,
      errorHistorySize: this.errorHistory.length,
      status: this.status,
      isRunning: this.runningState,
      uptime: this.runningState ? Date.now() - this.getStartTime() : 0,
    };
  }

  /**
   * Get module metrics
   */
  public getModuleMetrics(): any {
    const metrics: Record<string, any> = {};

    for (const [operation, metric] of this.moduleMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5),
      };
    }

    return metrics;
  }

  /**
   * Get module debug info - helper method for consistency
   */
  getModuleDebugInfo(): any {
    return this.getDebugInfo();
  }

  /**
   * Check if module is initialized - helper method for consistency
   */
  isModuleInitialized(): boolean {
    return this.runningState;
  }
}
