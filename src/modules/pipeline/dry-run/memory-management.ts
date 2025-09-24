/**
 * Dry-Run Memory Management System
 *
 * 提供统一的内存管理、资源清理和性能监控
 * 防止内存泄漏，确保系统稳定性
 */

import type { Disposable, ResourceUsage } from './memory-interface.js';

/**
 * 资源类型枚举
 */
export enum ResourceType {
  EXECUTION_CONTEXT = 'execution-context',
  SIMULATED_DATA = 'simulated-data',
  RESPONSE_CACHE = 'response-cache',
  DRY_RUN_RESULT = 'dry-run-result',
  BIDIRECTIONAL_RESULT = 'bidirectional-result',
  HISTORICAL_DATA = 'historical-data',
  TRANSFORMATION_RULE = 'transformation-rule',
  VALIDATION_RESULT = 'validation-result',
  PERFORMANCE_METRIC = 'performance-metric'
}

/**
 * 内存使用配置
 */
export interface MemoryConfig {
  /** 最大内存使用量 (MB) */
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
 * 资源使用信息
 */
export interface ResourceInfo {
  /** 资源ID */
  id: string;
  /** 资源类型 */
  type: ResourceType;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 估计大小 (bytes) */
  estimatedSize: number;
  /** 访问次数 */
  accessCount: number;
  /** 是否活跃 */
  isActive: boolean;
  /** 资源标签 */
  tags: string[];
  /** 额外元数据 */
  metadata: Record<string, any>;
}

/**
 * 内存使用统计
 */
export interface MemoryStats {
  /** 总内存使用量 (bytes) */
  totalUsage: number;
  /** 资源总数 */
  totalResources: number;
  /** 按类型分组的资源数 */
  resourcesByType: Record<ResourceType, number>;
  /** 活跃资源数 */
  activeResources: number;
  /** 缓存命中率 */
  cacheHitRate: number;
  /** 清理的资源数 */
  cleanedResources: number;
  /** 内存使用率 (0-1) */
  memoryUsageRatio: number;
  /** 最后清理时间 */
  lastCleanupTime: number;
  /** 性能指标 */
  performance: {
    averageCleanupTime: number;
    totalCleanupTime: number;
    cleanupCount: number;
    averageAccessTime: number;
  };
}

/**
 * 清理策略
 */
export type CleanupStrategy =
  | 'lru'          // 最近最少使用
  | 'lfu'          // 最不经常使用
  | 'fifo'         // 先进先出
  | 'ttl-based'    // 基于生存时间
  | 'size-based'   // 基于大小
  | 'hybrid';      // 混合策略

/**
 * 清理结果
 */
export interface CleanupResult {
  /** 清理的资源数 */
  cleanedResources: number;
  /** 释放的内存 (bytes) */
  freedMemory: number;
  /** 清理时间 (ms) */
  cleanupTime: number;
  /** 清理的资源类型分布 */
  cleanedByType: Record<ResourceType, number>;
  /** 是否达到临界状态 */
  wasCritical: boolean;
  /** 剩余资源数 */
  remainingResources: number;
}

/**
 * 资源访问回调
 */
export interface ResourceAccessCallbacks {
  /** 资源创建时 */
  onCreate?: (resource: ResourceInfo) => void;
  /** 资源访问时 */
  onAccess?: (resource: ResourceInfo) => void;
  /** 资源更新时 */
  onUpdate?: (resource: ResourceInfo) => void;
  /** 资源删除时 */
  onDelete?: (resource: ResourceInfo) => void;
  /** 内存警告时 */
  onMemoryWarning?: (stats: MemoryStats) => void;
  /** 内存临界时 */
  onMemoryCritical?: (stats: MemoryStats) => void;
  /** 清理完成时 */
  onCleanup?: (result: CleanupResult) => void;
}

/**
 * 内存管理器
 */
export class MemoryManager {
  private resources: Map<string, ResourceInfo> = new Map();
  private resourceData: Map<string, any> = new Map();
  private config: MemoryConfig;
  private stats: MemoryStats;
  private cleanupInterval?: NodeJS.Timeout;
  private callbacks: ResourceAccessCallbacks;
  private cleanupStrategy: CleanupStrategy;

  constructor(
    config: Partial<MemoryConfig> = {},
    callbacks: ResourceAccessCallbacks = {},
    cleanupStrategy: CleanupStrategy = 'hybrid'
  ) {
    this.config = {
      maxMemoryUsage: 512 * 1024 * 1024, // 512MB
      cleanupInterval: 60000, // 1 minute
      resourceTTL: 300000, // 5 minutes
      maxCacheSize: 1000,
      enableMonitoring: true,
      enableAutoCleanup: true,
      warningThreshold: 0.7,
      criticalThreshold: 0.9,
      ...config
    };

    this.callbacks = callbacks;
    this.cleanupStrategy = cleanupStrategy;

    // 初始化统计信息
    this.stats = this.initializeStats();

    // 启动监控
    if (this.config.enableAutoCleanup) {
      this.startAutoCleanup();
    }

    if (this.config.enableMonitoring) {
      this.startMemoryMonitoring();
    }
  }

  /**
   * 注册资源
   */
  registerResource(
    id: string,
    type: ResourceType,
    data: any,
    estimatedSize: number = 1024,
    tags: string[] = [],
    metadata: Record<string, any> = {}
  ): void {
    const now = Date.now();

    // 检查是否已存在
    if (this.resources.has(id)) {
      this.updateResource(id, data, estimatedSize);
      return;
    }

    const resource: ResourceInfo = {
      id,
      type,
      createdAt: now,
      lastAccessedAt: now,
      estimatedSize,
      accessCount: 0,
      isActive: true,
      tags,
      metadata
    };

    this.resources.set(id, resource);
    this.resourceData.set(id, data);

    // 更新统计
    this.updateStats(resource, 'create');

    // 触发回调
    if (this.callbacks.onCreate) {
      this.callbacks.onCreate(resource);
    }

    // 检查内存使用情况
    this.checkMemoryUsage();
  }

  /**
   * 获取资源
   */
  getResource<T = any>(id: string): T | null {
    const resource = this.resources.get(id);
    if (!resource || !resource.isActive) {
      return null;
    }

    // 更新访问信息
    resource.lastAccessedAt = Date.now();
    resource.accessCount++;

    // 更新统计
    this.updateStats(resource, 'access');

    // 触发回调
    if (this.callbacks.onAccess) {
      this.callbacks.onAccess(resource);
    }

    return this.resourceData.get(id) as T;
  }

  /**
   * 更新资源
   */
  updateResource(
    id: string,
    data: any,
    newEstimatedSize?: number
  ): boolean {
    const resource = this.resources.get(id);
    if (!resource) {
      return false;
    }

    const oldSize = resource.estimatedSize;
    if (newEstimatedSize !== undefined) {
      resource.estimatedSize = newEstimatedSize;
    }

    resource.lastAccessedAt = Date.now();
    resource.isActive = true;

    this.resourceData.set(id, data);

    // 更新统计
    this.updateStats(resource, 'update', oldSize);

    // 触发回调
    if (this.callbacks.onUpdate) {
      this.callbacks.onUpdate(resource);
    }

    return true;
  }

  /**
   * 删除资源
   */
  deleteResource(id: string): boolean {
    const resource = this.resources.get(id);
    if (!resource) {
      return false;
    }

    const size = resource.estimatedSize;
    this.resources.delete(id);
    this.resourceData.delete(id);

    // 更新统计
    this.updateStats(resource, 'delete', size);

    // 触发回调
    if (this.callbacks.onDelete) {
      this.callbacks.onDelete(resource);
    }

    return true;
  }

  /**
   * 根据类型获取资源
   */
  getResourcesByType(type: ResourceType): ResourceInfo[] {
    return Array.from(this.resources.values()).filter(r => r.type === type && r.isActive);
  }

  /**
   * 根据标签获取资源
   */
  getResourcesByTag(tag: string): ResourceInfo[] {
    return Array.from(this.resources.values()).filter(r =>
      r.isActive && r.tags.includes(tag)
    );
  }

  /**
   * 执行清理
   */
  async cleanup(force: boolean = false): Promise<CleanupResult> {
    const startTime = Date.now();
    const initialResourceCount = this.resources.size;

    // 确定要清理的资源
    const resourcesToClean = this.selectResourcesForCleanup(force);

    // 执行清理
    let freedMemory = 0;
    const cleanedByType: Record<ResourceType, number> = {} as any;

    for (const resource of resourcesToClean) {
      if (this.deleteResource(resource.id)) {
        freedMemory += resource.estimatedSize;
        cleanedByType[resource.type] = (cleanedByType[resource.type] || 0) + 1;
      }
    }

    const cleanupTime = Date.now() - startTime;

    // 更新统计
    this.stats.cleanedResources += resourcesToClean.length;
    this.stats.lastCleanupTime = Date.now();
    this.stats.performance.totalCleanupTime += cleanupTime;
    this.stats.performance.cleanupCount++;
    this.stats.performance.averageCleanupTime =
      this.stats.performance.totalCleanupTime / this.stats.performance.cleanupCount;

    const result: CleanupResult = {
      cleanedResources: resourcesToClean.length,
      freedMemory,
      cleanupTime,
      cleanedByType,
      wasCritical: this.isMemoryCritical(),
      remainingResources: this.resources.size
    };

    // 触发回调
    if (this.callbacks.onCleanup) {
      this.callbacks.onCleanup(result);
    }

    return result;
  }

  /**
   * 选择要清理的资源
   */
  private selectResourcesForCleanup(force: boolean): ResourceInfo[] {
    const allResources = Array.from(this.resources.values()).filter(r => r.isActive);

    if (force || this.isMemoryCritical()) {
      // 临界状态：清理尽可能多的资源
      return allResources;
    }

    // 正常清理：根据策略选择资源
    const targetCount = Math.floor(allResources.length * 0.3); // 清理30%

    switch (this.cleanupStrategy) {
      case 'lru':
        return this.selectLRU(allResources, targetCount);
      case 'lfu':
        return this.selectLFU(allResources, targetCount);
      case 'fifo':
        return this.selectFIFO(allResources, targetCount);
      case 'ttl-based':
        return this.selectTTLBased(allResources, targetCount);
      case 'size-based':
        return this.selectSizeBased(allResources, targetCount);
      case 'hybrid':
        return this.selectHybrid(allResources, targetCount);
      default:
        return this.selectLRU(allResources, targetCount);
    }
  }

  /**
   * LRU (Least Recently Used) 策略
   */
  private selectLRU(resources: ResourceInfo[], targetCount: number): ResourceInfo[] {
    return resources
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
      .slice(0, targetCount);
  }

  /**
   * LFU (Least Frequently Used) 策略
   */
  private selectLFU(resources: ResourceInfo[], targetCount: number): ResourceInfo[] {
    return resources
      .sort((a, b) => a.accessCount - b.accessCount)
      .slice(0, targetCount);
  }

  /**
   * FIFO (First In First Out) 策略
   */
  private selectFIFO(resources: ResourceInfo[], targetCount: number): ResourceInfo[] {
    return resources
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, targetCount);
  }

  /**
   * TTL-Based 策略
   */
  private selectTTLBased(resources: ResourceInfo[], targetCount: number): ResourceInfo[] {
    const now = Date.now();
    return resources
      .filter(r => now - r.createdAt > this.config.resourceTTL)
      .slice(0, targetCount);
  }

  /**
   * Size-Based 策略
   */
  private selectSizeBased(resources: ResourceInfo[], targetCount: number): ResourceInfo[] {
    return resources
      .sort((a, b) => b.estimatedSize - a.estimatedSize)
      .slice(0, targetCount);
  }

  /**
   * Hybrid 混合策略
   */
  private selectHybrid(resources: ResourceInfo[], targetCount: number): ResourceInfo[] {
    const now = Date.now();

    // 计算分数 (分数越低越应该被清理)
    const scored = resources.map(r => {
      const age = now - r.createdAt;
      const inactivity = now - r.lastAccessedAt;
      const ttlRatio = age / this.config.resourceTTL;

      // 综合评分：考虑大小、活跃度、年龄
      let score = 0;
      score += (r.estimatedSize / 1024) * 0.4; // 大小权重40%
      score += (inactivity / age) * 0.3; // 不活跃权重30%
      score += ttlRatio * 0.3; // 年龄权重30%

      return { resource: r, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .map(s => s.resource)
      .slice(0, targetCount);
  }

  /**
   * 启动自动清理
   */
  private startAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanup();
      } catch (error) {
        console.error('Auto cleanup failed:', error);
      }
    }, this.config.cleanupInterval);
  }

  /**
   * 启动内存监控
   */
  private startMemoryMonitoring(): void {
    setInterval(() => {
      this.checkMemoryUsage();
    }, 5000); // 每5秒检查一次
  }

  /**
   * 检查内存使用情况
   */
  private checkMemoryUsage(): void {
    if (this.isMemoryCritical()) {
      if (this.callbacks.onMemoryCritical) {
        this.callbacks.onMemoryCritical(this.stats);
      }
      // 立即执行清理
      this.cleanup(true);
    } else if (this.isMemoryWarning()) {
      if (this.callbacks.onMemoryWarning) {
        this.callbacks.onMemoryWarning(this.stats);
      }
    }
  }

  /**
   * 检查是否达到警告阈值
   */
  private isMemoryWarning(): boolean {
    return this.stats.memoryUsageRatio >= this.config.warningThreshold;
  }

  /**
   * 检查是否达到临界阈值
   */
  private isMemoryCritical(): boolean {
    return this.stats.memoryUsageRatio >= this.config.criticalThreshold;
  }

  /**
   * 更新统计信息
   */
  private updateStats(resource: ResourceInfo, operation: 'create' | 'access' | 'update' | 'delete', oldSize?: number): void {
    switch (operation) {
      case 'create':
        this.stats.totalUsage += resource.estimatedSize;
        this.stats.totalResources++;
        this.stats.resourcesByType[resource.type]++;
        this.stats.activeResources++;
        break;

      case 'access':
        // 更新缓存命中率统计
        break;

      case 'update':
        if (oldSize !== undefined) {
          this.stats.totalUsage += (resource.estimatedSize - oldSize);
        }
        break;

      case 'delete':
        this.stats.totalUsage -= resource.estimatedSize;
        this.stats.activeResources--;
        this.stats.resourcesByType[resource.type]--;
        break;
    }

    // 更新内存使用率
    this.stats.memoryUsageRatio = this.stats.totalUsage / this.config.maxMemoryUsage;
  }

  /**
   * 初始化统计信息
   */
  private initializeStats(): MemoryStats {
    const resourcesByType: Record<ResourceType, number> = {} as any;
    Object.values(ResourceType).forEach(type => {
      resourcesByType[type] = 0;
    });

    return {
      totalUsage: 0,
      totalResources: 0,
      resourcesByType,
      activeResources: 0,
      cacheHitRate: 0,
      cleanedResources: 0,
      memoryUsageRatio: 0,
      lastCleanupTime: 0,
      performance: {
        averageCleanupTime: 0,
        totalCleanupTime: 0,
        cleanupCount: 0,
        averageAccessTime: 0
      }
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): MemoryStats {
    return { ...this.stats };
  }

  /**
   * 获取资源信息
   */
  getResourceInfo(id: string): ResourceInfo | null {
    return this.resources.get(id) || null;
  }

  /**
   * 获取所有资源信息
   */
  getAllResources(): ResourceInfo[] {
    return Array.from(this.resources.values());
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // 重新启动自动清理
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    if (this.config.enableAutoCleanup) {
      this.startAutoCleanup();
    }
  }

  /**
   * 设置清理策略
   */
  setCleanupStrategy(strategy: CleanupStrategy): void {
    this.cleanupStrategy = strategy;
  }

  /**
   * 设置回调
   */
  setCallbacks(callbacks: ResourceAccessCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * 强制清理所有资源
   */
  async cleanupAll(): Promise<CleanupResult> {
    const result = await this.cleanup(true);
    this.resources.clear();
    this.resourceData.clear();

    // 重置统计
    this.stats = this.initializeStats();

    return result;
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    // 停止自动清理
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // 清理所有资源
    this.cleanupAll();
  }
}

/**
 * 内存管理器接口扩展
 */
export interface MemoryManagerExtension {
  /** 获取资源使用情况 */
  getResourceUsage(): ResourceUsage;
  /** 优化内存使用 */
  optimizeMemoryUsage(): Promise<void>;
  /** 获取内存报告 */
  getMemoryReport(): string;
}

/**
 * 默认配置
 */
export const defaultMemoryConfig: MemoryConfig = {
  maxMemoryUsage: 512 * 1024 * 1024, // 512MB
  cleanupInterval: 60000, // 1 minute
  resourceTTL: 300000, // 5 minutes
  maxCacheSize: 1000,
  enableMonitoring: true,
  enableAutoCleanup: true,
  warningThreshold: 0.7,
  criticalThreshold: 0.9
};

/**
 * 导出单例实例
 */
export const memoryManager = new MemoryManager(defaultMemoryConfig, {
  onMemoryWarning: (stats) => {
    console.warn(`[MemoryManager] Memory usage warning: ${(stats.memoryUsageRatio * 100).toFixed(1)}%`);
  },
  onMemoryCritical: (stats) => {
    console.error(`[MemoryManager] Memory usage critical: ${(stats.memoryUsageRatio * 100).toFixed(1)}%`);
  },
  onCleanup: (result) => {
    console.log(`[MemoryManager] Cleaned up ${result.cleanedResources} resources, freed ${result.freedMemory} bytes`);
  }
});