/**
 * Base Module Class
 * 基础模块类 - 所有模块的基类
 */

import { EventEmitter } from 'events';
import { DebugEventBus } from "rcc-debugcenter"; 
import { DebugCenter } from "rcc-debugcenter/dist/core/DebugCenter.js";
import { DebugEnhancementManager } from '../modules/debug/debug-enhancement-manager.js';

/**
 * 模块基本信息接口
 */
export interface ModuleInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  dependencies?: string[];
}

/**
 * 模块状态枚举
 */
export enum ModuleStatus {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  ERROR = 'error'
}

/**
 * 基础模块类
 */
export abstract class BaseModule extends EventEmitter {
  protected info: ModuleInfo;
  protected status: ModuleStatus = ModuleStatus.STOPPED;
  protected isRunning: boolean = false;

  // Debug enhancement properties - unified approach
  private debugEnhancementManager: DebugEnhancementManager | null = null;
  private debugEnhancement: any = null;

  // Legacy debug properties for backward compatibility
  public debugEventBus: DebugEventBus | null = null;
  public isDebugEnhanced = false;
  public moduleMetrics: Map<string, any> = new Map();
  public operationHistory: any[] = [];
  public errorHistory: any[] = [];
  public maxHistorySize = 50;

  constructor(info: ModuleInfo) {
    super();
    this.info = info;

    // Initialize unified debug enhancements
    this.initializeUnifiedDebugEnhancements();

    // Initialize legacy debug enhancements for backward compatibility
    this.initializeDebugEnhancements();
  }

  /**
   * 获取模块信息
   */
  getInfo(): ModuleInfo {
    return { ...this.info };
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
    return this.isRunning;
  }

  /**
   * 初始化模块 - 子类必须实现
   */
  abstract initialize(config?: any): Promise<void>;

  /**
   * 启动模块
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn(`Module ${this.info.id} is already running`);
      return;
    }

    try {
      this.status = ModuleStatus.STARTING;
      this.emit('starting', this.info);

      // 子类可以重写此方法来实现启动逻辑
      await this.doStart();

      this.status = ModuleStatus.RUNNING;
      this.isRunning = true;
      this.emit('started', this.info);

      console.log(`✅ Module ${this.info.id} started successfully`);
    } catch (error) {
      this.status = ModuleStatus.ERROR;
      this.emit('error', { module: this.info, error });
      throw error;
    }
  }

  /**
   * 停止模块
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.warn(`Module ${this.info.id} is not running`);
      return;
    }

    try {
      this.status = ModuleStatus.STOPPING;
      this.emit('stopping', this.info);

      // 子类可以重写此方法来实现停止逻辑
      await this.doStop();

      this.status = ModuleStatus.STOPPED;
      this.isRunning = false;
      this.emit('stopped', this.info);

      console.log(`🛑 Module ${this.info.id} stopped successfully`);
    } catch (error) {
      this.status = ModuleStatus.ERROR;
      this.emit('error', { module: this.info, error });
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
    return {
      id: this.info.id,
      name: this.info.name,
      version: this.info.version,
      status: this.status,
      isRunning: this.isRunning,
      uptime: this.isRunning ? Date.now() - this.getStartTime() : 0
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
    // 这里可以存储实际的启动时间
    // 为了简化，返回当前时间
    return Date.now();
  }

  /**
   * 处理模块错误
   */
  protected handleError(error: Error, context?: string): void {
    this.emit('error', {
      module: this.info,
      error,
      context,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Initialize unified debug enhancements
   */
  private initializeUnifiedDebugEnhancements(): void {
    try {
      const debugCenter = new DebugCenter();
      this.debugEnhancementManager = DebugEnhancementManager.getInstance(debugCenter);

      // Register enhancement for this module
      this.debugEnhancement = this.debugEnhancementManager.registerEnhancement(this.info.id, {
        enabled: true,
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        maxHistorySize: this.maxHistorySize
      });

      console.log(`BaseModule unified debug enhancements initialized for ${this.info.id}`);
    } catch (error) {
      console.warn(`Failed to initialize BaseModule unified debug enhancements for ${this.info.id}:`, error);
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
    // Use unified debug enhancement if available
    if (this.debugEnhancement && this.debugEnhancement.recordMetric) {
      this.debugEnhancement.recordMetric(operation, Date.now(), {
        moduleId: this.info.id,
        operation
      });
    }

    // Fallback to legacy implementation
    if (!this.moduleMetrics.has(operation)) {
      this.moduleMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.moduleMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to operation history - unified approach
   */
  public addToOperationHistory(operation: any): void {
    // Use unified debug enhancement if available
    if (this.debugEnhancement && this.debugEnhancement.addRequestToHistory) {
      this.debugEnhancement.addRequestToHistory({
        ...operation,
        moduleId: this.info.id,
        type: 'operation'
      });
    }

    // Fallback to legacy implementation
    this.operationHistory.push(operation);

    // Keep only recent history
    if (this.operationHistory.length > this.maxHistorySize) {
      this.operationHistory.shift();
    }
  }

  /**
   * Add to error history - unified approach
   */
  public addToErrorHistory(error: any): void {
    // Use unified debug enhancement if available
    if (this.debugEnhancement && this.debugEnhancement.addErrorToHistory) {
      this.debugEnhancement.addErrorToHistory({
        ...error,
        moduleId: this.info.id,
        timestamp: Date.now()
      });
    }

    // Fallback to legacy implementation
    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  public publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.info.id,
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          ...data,
          moduleId: this.info.id,
          source: 'base-module'
        }
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information - unified approach
   */
  getDebugStatus(): any {
    const baseStatus = {
      moduleId: this.info.id,
      name: this.info.name,
      version: this.info.version,
      status: this.status,
      isRunning: this.isRunning,
      isEnhanced: this.isDebugEnhanced
    };

    // Add unified debug information if available
    if (this.debugEnhancementManager) {
      return {
        ...baseStatus,
        unifiedDebugInfo: this.debugEnhancementManager.getSystemDebugStatus(),
        enhancementInfo: this.debugEnhancement ? {
          isActive: this.debugEnhancement.isActive,
          metricsCount: this.debugEnhancement.metrics.size,
          requestHistoryCount: this.debugEnhancement.requestHistory.length,
          errorHistoryCount: this.debugEnhancement.errorHistory.length
        } : null
      };
    }

    // Fallback to legacy implementation
    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      moduleMetrics: this.getModuleMetrics(),
      operationHistory: [...this.operationHistory.slice(-10)], // Last 10 operations
      errorHistory: [...this.errorHistory.slice(-10)] // Last 10 errors
    };
  }

  /**
   * Get detailed debug information
   */
  public getDebugInfo(): any {
    return {
      moduleId: this.info.id,
      name: this.info.name,
      version: this.info.version,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      operationHistorySize: this.operationHistory.length,
      errorHistorySize: this.errorHistory.length,
      status: this.status,
      isRunning: this.isRunning,
      uptime: this.isRunning ? Date.now() - this.getStartTime() : 0
    };
  }

  /**
   * Get module metrics
   */
  public getModuleMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.moduleMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
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
    return this.isRunning;
  }
}