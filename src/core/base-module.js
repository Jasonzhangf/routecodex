/**
 * Base Module Class
 * 基础模块类 - 所有模块的基类
 */
import { EventEmitter } from 'events';
import { DebugEventBus, DebugCenter } from 'rcc-debugcenter';
import { DebugEnhancementManager } from '../modules/debug/debug-enhancement-manager.js';
/**
 * 模块状态枚举
 */
export var ModuleStatus;
(function (ModuleStatus) {
  ModuleStatus['STOPPED'] = 'stopped';
  ModuleStatus['STARTING'] = 'starting';
  ModuleStatus['RUNNING'] = 'running';
  ModuleStatus['STOPPING'] = 'stopping';
  ModuleStatus['ERROR'] = 'error';
})(ModuleStatus || (ModuleStatus = {}));
/**
 * 基础模块类
 */
export class BaseModule extends EventEmitter {
  constructor(info) {
    super();
    this.status = ModuleStatus.STOPPED;
    this.isRunning = false;
    // Debug enhancement properties - unified approach
    this.debugEnhancementManager = null;
    this.debugEnhancement = null;
    // Legacy debug properties for backward compatibility
    this.debugEventBus = null;
    this.isDebugEnhanced = false;
    this.moduleMetrics = new Map();
    this.operationHistory = [];
    this.errorHistory = [];
    this.maxHistorySize = 50;
    this.info = info;
    // Initialize unified debug enhancements
    this.initializeUnifiedDebugEnhancements();
    // Initialize legacy debug enhancements for backward compatibility
    this.initializeDebugEnhancements();
  }
  /**
   * 获取模块信息
   */
  getInfo() {
    return { ...this.info };
  }
  /**
   * 获取模块状态
   */
  getStatus() {
    return this.status;
  }
  /**
   * 检查模块是否运行中
   */
  isModuleRunning() {
    return this.isRunning;
  }
  /**
   * 启动模块
   */
  async start() {
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
  async stop() {
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
  async restart() {
    await this.stop();
    await this.start();
  }
  /**
   * 获取模块统计信息
   */
  getStats() {
    return {
      id: this.info.id,
      name: this.info.name,
      version: this.info.version,
      status: this.status,
      isRunning: this.isRunning,
      uptime: this.isRunning ? Date.now() - this.getStartTime() : 0,
    };
  }
  /**
   * 启动逻辑 - 子类可以重写
   */
  async doStart() {
    // 默认实现：子类可以重写此方法
  }
  /**
   * 停止逻辑 - 子类可以重写
   */
  async doStop() {
    // 默认实现：子类可以重写此方法
  }
  /**
   * 获取启动时间
   */
  getStartTime() {
    // 这里可以存储实际的启动时间
    // 为了简化，返回当前时间
    return Date.now();
  }
  /**
   * 处理模块错误
   */
  handleError(error, context) {
    this.emit('error', {
      module: this.info,
      error,
      context,
      timestamp: new Date().toISOString(),
    });
  }
  /**
   * Initialize unified debug enhancements
   */
  initializeUnifiedDebugEnhancements() {
    try {
      const debugCenter = DebugCenter.getInstance();
      this.debugEnhancementManager = DebugEnhancementManager.getInstance(debugCenter);
      // Register enhancement for this module
      this.debugEnhancement = this.debugEnhancementManager.registerEnhancement(this.info.id, {
        enabled: true,
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        maxHistorySize: this.maxHistorySize,
      });
      console.log(`BaseModule unified debug enhancements initialized for ${this.info.id}`);
    } catch (error) {
      console.warn(
        `Failed to initialize BaseModule unified debug enhancements for ${this.info.id}:`,
        error
      );
      this.debugEnhancementManager = null;
    }
  }
  /**
   * Initialize debug enhancements
   */
  initializeDebugEnhancements() {
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
  recordModuleMetric(operation, data) {
    // Use unified debug enhancement if available
    if (this.debugEnhancement && this.debugEnhancement.recordMetric) {
      this.debugEnhancement.recordMetric(operation, Date.now(), {
        moduleId: this.info.id,
        operation,
      });
    }
    // Fallback to legacy implementation
    if (!this.moduleMetrics.has(operation)) {
      this.moduleMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now(),
      });
    }
    const metric = this.moduleMetrics.get(operation);
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
  addToOperationHistory(operation) {
    // Use unified debug enhancement if available
    if (this.debugEnhancement && this.debugEnhancement.addRequestToHistory) {
      this.debugEnhancement.addRequestToHistory({
        ...operation,
        moduleId: this.info.id,
        type: 'operation',
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
  addToErrorHistory(error) {
    // Use unified debug enhancement if available
    if (this.debugEnhancement && this.debugEnhancement.addErrorToHistory) {
      this.debugEnhancement.addErrorToHistory({
        ...error,
        moduleId: this.info.id,
        timestamp: Date.now(),
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
  publishDebugEvent(type, data) {
    if (!this.isDebugEnhanced || !this.debugEventBus) return;
    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.info.id,
        operationId: type,
        timestamp: Date.now(),
        type: 'debug',
        position: 'middle',
        data: {
          ...data,
          moduleId: this.info.id,
          source: 'base-module',
        },
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }
  /**
   * Get debug status with enhanced information - unified approach
   */
  getDebugStatus() {
    const baseStatus = {
      moduleId: this.info.id,
      name: this.info.name,
      version: this.info.version,
      status: this.status,
      isRunning: this.isRunning,
      isEnhanced: this.isDebugEnhanced,
    };
    // Add unified debug information if available
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
    // Fallback to legacy implementation
    if (!this.isDebugEnhanced) {
      return baseStatus;
    }
    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      moduleMetrics: this.getModuleMetrics(),
      operationHistory: [...this.operationHistory.slice(-10)], // Last 10 operations
      errorHistory: [...this.errorHistory.slice(-10)], // Last 10 errors
    };
  }
  /**
   * Get detailed debug information
   */
  getDebugInfo() {
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
      uptime: this.isRunning ? Date.now() - this.getStartTime() : 0,
    };
  }
  /**
   * Get module metrics
   */
  getModuleMetrics() {
    const metrics = {};
    for (const [operation, metric] of this.moduleMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5), // Last 5 values
      };
    }
    return metrics;
  }
  /**
   * Get module debug info - helper method for consistency
   */
  getModuleDebugInfo() {
    return this.getDebugInfo();
  }
  /**
   * Check if module is initialized - helper method for consistency
   */
  isModuleInitialized() {
    return this.isRunning;
  }
}
