/**
 * Memory Management Interfaces
 *
 * 定义内存管理系统的核心接口
 */

/**
 * 可释放资源接口
 */
export interface Disposable {
  /**
   * 释放资源
   */
  dispose(): void;

  /**
   * 检查资源是否已释放
   */
  isDisposed(): boolean;
}

/**
 * 资源使用信息
 */
export interface ResourceUsage {
  /** 总内存使用量 (bytes) */
  totalMemory: number;
  /** 可用内存量 (bytes) */
  availableMemory: number;
  /** 已使用内存百分比 */
  memoryUsagePercent: number;
  /** 堆内存使用量 (bytes) */
  heapUsed: number;
  /** 堆内存总量 (bytes) */
  heapTotal: number;
  /** 外部内存使用量 (bytes) */
  externalMemory: number;
  /** 进程ID */
  pid: number;
  /** 平台信息 */
  platform: string;
  /** Node.js 版本 */
  nodeVersion: string;
}

/**
 * 内存监控事件
 */
export interface MemoryEvent {
  /** 事件类型 */
  type: 'warning' | 'critical' | 'cleanup' | 'peak' | 'leak-detected';
  /** 事件时间戳 */
  timestamp: number;
  /** 内存使用信息 */
  memoryUsage: ResourceUsage;
  /** 事件详情 */
  details: Record<string, any>;
  /** 严重级别 */
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * 内存泄漏检测报告
 */
export interface MemoryLeakReport {
  /** 检测时间 */
  detectedAt: number;
  /** 泄漏的资源ID列表 */
  leakedResources: string[];
  /** 估计泄漏大小 (bytes) */
  estimatedLeakSize: number;
  /** 泄漏模式 */
  leakPattern: string;
  /** 建议修复措施 */
  recommendations: string[];
  /** 检测方法 */
  detectionMethod: string;
}

/**
 * 内存优化结果
 */
export interface MemoryOptimizationResult {
  /** 优化前内存使用量 */
  beforeOptimization: number;
  /** 优化后内存使用量 */
  afterOptimization: number;
  /** 释放的内存量 */
  freedMemory: number;
  /** 优化时间 (ms) */
  optimizationTime: number;
  /** 优化的资源数量 */
  optimizedResources: number;
  /** 成功率 */
  successRate: number;
  /** 优化详情 */
  details: {
    compressionRatio: number;
    cacheOptimization: number;
    resourceCleanup: number;
    gcOptimization: number;
  };
}

/**
 * 内存快照
 */
export interface MemorySnapshot {
  /** 快照ID */
  snapshotId: string;
  /** 快照时间 */
  timestamp: number;
  /** 内存使用信息 */
  memoryUsage: ResourceUsage;
  /** 资源统计 */
  resourceStats: {
    totalResources: number;
    activeResources: number;
    cachedResources: number;
    largeResources: number;
  };
  /** 系统信息 */
  systemInfo: {
    uptime: number;
    loadAverage: number[];
    cpuUsage: number;
  };
  /** 自定义数据 */
  customData?: Record<string, any>;
}

/**
 * 内存管理配置接口
 */
export interface MemoryConfig {
  /** 最大内存使用量 (bytes) */
  maxMemoryUsage: number;
  /** 资源清理间隔 (ms) */
  cleanupInterval: number;
  /** 资源TTL (ms) */
  resourceTTL: number;
  /** 缓存大小限制 */
  maxCacheSize: number;
  /** 是否启用内存监控 */
  enableMonitoring: boolean;
  /** 是否启用自动清理 */
  enableAutoCleanup: boolean;
  /** 警告阈值 (0-1) */
  warningThreshold: number;
  /** 临界阈值 (0-1) */
  criticalThreshold: number;
}

/**
 * 资源池接口
 */
export interface ResourcePool<T> {
  /** 获取资源 */
  acquire(): Promise<T>;
  /** 释放资源 */
  release(resource: T): Promise<void>;
  /** 获取池状态 */
  getStatus(): {
    total: number;
    available: number;
    inUse: number;
    waiting: number;
  };
  /** 清空池 */
  clear(): Promise<void>;
  /** 销毁池 */
  destroy(): Promise<void>;
}

/**
 * 内存分析器接口
 */
export interface MemoryAnalyzer {
  /** 分析内存使用模式 */
  analyzeUsagePattern(): Promise<{
    pattern: string;
    confidence: number;
    description: string;
    recommendations: string[];
  }>;
  /** 检测内存泄漏 */
  detectLeaks(): Promise<MemoryLeakReport>;
  /** 生成内存报告 */
  generateReport(): Promise<string>;
  /** 创建内存快照 */
  createSnapshot(): Promise<MemorySnapshot>;
  /** 比较快照 */
  compareSnapshots(snapshot1: MemorySnapshot, snapshot2: MemorySnapshot): Promise<{
    differences: Record<string, number>;
    changes: string[];
    analysis: string;
  }>;
}

/**
 * 缓存接口
 */
export interface Cache<K, V> {
  /** 设置缓存 */
  set(key: K, value: V, ttl?: number): void;
  /** 获取缓存 */
  get(key: K): V | null;
  /** 删除缓存 */
  delete(key: K): boolean;
  /** 清空缓存 */
  clear(): void;
  /** 获取缓存大小 */
  size(): number;
  /** 获取缓存状态 */
  getStats(): {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    maxSize: number;
  };
}

/**
 * 垃圾回收控制器
 */
export interface GCController {
  /** 强制执行垃圾回收 */
  forceGC(): Promise<void>;
  /** 获取GC统计信息 */
  getGCStats(): {
    totalCollections: number;
    totalCollectionTime: number;
    averageCollectionTime: number;
    lastCollectionTime: number;
  };
  /** 设置GC阈值 */
  setThreshold(threshold: number): void;
  /** 启动自动GC */
  startAutoGC(): void;
  /** 停止自动GC */
  stopAutoGC(): void;
}

/**
 * 内存事件监听器
 */
export interface MemoryEventListener {
  /** 监听内存事件 */
  on(event: string, callback: (event: MemoryEvent) => void): void;
  /** 移除监听器 */
  off(event: string, callback: (event: MemoryEvent) => void): void;
  /** 获取所有监听器 */
  getListeners(): Record<string, Function[]>;
}

/**
 * 内存监控器
 */
export interface MemoryMonitor {
  /** 开始监控 */
  start(): void;
  /** 停止监控 */
  stop(): void;
  /** 获取当前内存使用情况 */
  getCurrentUsage(): ResourceUsage;
  /** 获取历史数据 */
  getHistory(timeRange?: { start: number; end: number }): ResourceUsage[];
  /** 设置报警阈值 */
  setThresholds(warning: number, critical: number): void;
  /** 检查是否超出阈值 */
  checkThresholds(): boolean;
}

/**
 * 性能指标收集器
 */
export interface MetricsCollector {
  /** 记录指标 */
  recordMetric(name: string, value: number, tags?: Record<string, string>): void;
  /** 获取指标 */
  getMetric(name: string, timeRange?: { start: number; end: number }): Array<{
    timestamp: number;
    value: number;
    tags?: Record<string, string>;
  }>;
  /** 获取所有指标 */
  getAllMetrics(): Record<string, Array<{
    timestamp: number;
    value: number;
    tags?: Record<string, string>;
  }>>;
  /** 清除指标 */
  clearMetric(name: string): void;
  /** 清除所有指标 */
  clearAll(): void;
}