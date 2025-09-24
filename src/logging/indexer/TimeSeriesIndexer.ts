/**
 * 时间序列索引系统
 * 
 * 基于时间戳构建高效的日志索引，支持快速查询和范围搜索
 */

import { EventEmitter } from 'events';

import type { 
  UnifiedLogEntry, 
  LogFilter, 
  LogQueryResult,
  IndexStatus 
} from '../types.js';
import type { LogQueryEngine } from '../interfaces.js';
import { QUERY_CONSTANTS } from '../constants.js';

/**
 * 索引配置
 */
export interface TimeSeriesIndexConfig {
  /** 索引名称 */
  name: string;
  /** 时间分片间隔 (ms) */
  shardInterval?: number;
  /** 最大索引条目数 */
  maxEntries?: number;
  /** 内存限制 (bytes) */
  memoryLimit?: number;
  /** 是否启用压缩 */
  enableCompression?: boolean;
  /** 压缩阈值 */
  compressionThreshold?: number;
  /** 索引过期时间 (ms) */
  ttl?: number;
}

/**
 * 时间分片
 */
export interface TimeShard {
  /** 分片ID */
  id: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 日志条目 */
  entries: UnifiedLogEntry[];
  /** 条目数量 */
  count: number;
  /** 内存使用 (bytes) */
  memoryUsage: number;
  /** 最后访问时间 */
  lastAccess: number;
  /** 是否已压缩 */
  isCompressed: boolean;
}

/**
 * 索引元数据
 */
export interface IndexMetadata {
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  lastUpdated: number;
  /** 总条目数 */
  totalEntries: number;
  /** 分片数量 */
  shardCount: number;
  /** 时间范围 */
  timeRange: {
    start: number;
    end: number;
  };
  /** 模块分布 */
  moduleDistribution: Record<string, number>;
  /** 级别分布 */
  levelDistribution: Record<string, number>;
}

/**
 * 查询优化器
 */
export interface QueryOptimizer {
  /** 优化的查询计划 */
  plan: QueryPlan;
  /** 预估成本 */
  estimatedCost: number;
  /** 预估结果数 */
  estimatedResults: number;
  /** 建议的索引使用 */
  recommendedIndexes: string[];
}

/**
 * 查询计划
 */
export interface QueryPlan {
  /** 需要查询的分片 */
  shards: string[];
  /** 查询策略 */
  strategy: 'full_scan' | 'time_range' | 'index_lookup' | 'hybrid';
  /** 预估时间 */
  estimatedTime: number;
  /** 内存使用预估 */
  estimatedMemory: number;
}

/**
 * 时间序列索引引擎
 */
export class TimeSeriesIndexEngine extends EventEmitter implements LogQueryEngine {
  private config: Required<TimeSeriesIndexConfig>;
  private shards = new Map<string, TimeShard>();
  private metadata: IndexMetadata;
  private isOptimizing = false;
  private lastOptimization = 0;

  constructor(config: TimeSeriesIndexConfig) {
    super();
    
    this.config = {
      name: config.name,
      shardInterval: config.shardInterval || (60 * 60 * 1000), // 默认1小时
      maxEntries: config.maxEntries || QUERY_CONSTANTS.MAX_LIMIT,
      memoryLimit: config.memoryLimit || (500 * 1024 * 1024), // 默认500MB
      enableCompression: config.enableCompression ?? true,
      compressionThreshold: config.compressionThreshold || 10000,
      ttl: config.ttl || (7 * 24 * 60 * 60 * 1000) // 默认7天
    };

    this.metadata = {
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      totalEntries: 0,
      shardCount: 0,
      timeRange: { start: Infinity, end: -Infinity },
      moduleDistribution: {},
      levelDistribution: {}
    };

    this.setupPeriodicMaintenance();
  }

  /**
   * 添加日志到索引
   */
  async index(logs: UnifiedLogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    const startTime = Date.now();
    
    // 按时间戳分组到分片
    const shards = this.groupLogsByShards(logs);
    
    for (const [shardId, entries] of shards) {
      await this.addToShard(shardId, entries);
    }

    // 更新元数据
    this.updateMetadata();
    
    const indexTime = Date.now() - startTime;
    this.emit('indexed', { count: logs.length, indexTime });
    
    // 检查是否需要优化
    if (this.shouldOptimize()) {
      this.optimize().catch(error => {
        console.error('索引优化失败:', error);
      });
    }
  }

  /**
   * 查询日志
   */
  async query(filter: LogFilter): Promise<LogQueryResult> {
    const startTime = Date.now();
    
    // 优化查询计划
    const optimizer = this.createQueryPlan(filter);
    
    if (optimizer.shards.length === 0) {
      return {
        logs: [],
        total: 0,
        filter,
        queryTime: Date.now() - startTime
      };
    }

    // 执行查询
    const results = await this.executeQueryPlan(optimizer, filter);
    
    const queryTime = Date.now() - startTime;
    
    return {
      logs: results.logs,
      total: results.total,
      filter,
      queryTime
    };
  }

  /**
   * 从索引中移除日志
   */
  async remove(index: string): Promise<void> {
    // 简化实现：移除指定时间范围的索引
    const [startStr, endStr] = index.split('-');
    const startTime = parseInt(startStr);
    const endTime = parseInt(endStr);
    
    if (isNaN(startTime) || isNaN(endTime)) {
      throw new Error('Invalid index format');
    }
    
    const shardsToRemove: string[] = [];
    
    for (const [shardId, shard] of this.shards) {
      if (shard.startTime >= startTime && shard.endTime <= endTime) {
        shardsToRemove.push(shardId);
      }
    }
    
    for (const shardId of shardsToRemove) {
      this.shards.delete(shardId);
    }
    
    this.updateMetadata();
    this.emit('removed', { count: shardsToRemove.length });
  }

  /**
   * 获取索引状态
   */
  getIndexStatus(): IndexStatus {
    const memoryUsage = this.calculateMemoryUsage();
    
    return {
      name: this.config.name,
      documentCount: this.metadata.totalEntries,
      size: memoryUsage,
      lastCheck: Date.now(),
      lastUpdate: this.metadata.lastUpdated,
      status: this.isOptimizing ? 'optimizing' : 'active'
    };
  }

  /**
   * 优化索引
   */
  async optimize(): Promise<void> {
    if (this.isOptimizing) return;
    
    this.isOptimizing = true;
    this.emit('optimization_started');
    
    try {
      console.log(`🔧 开始优化索引: ${this.config.name}`);
      
      // 1. 合并小分片
      await this.mergeSmallShards();
      
      // 2. 压缩大分片
      await this.compressLargeShards();
      
      // 3. 清理过期数据
      await this.cleanupExpiredData();
      
      // 4. 重建元数据
      this.rebuildMetadata();
      
      this.lastOptimization = Date.now();
      
      console.log(`✅ 索引优化完成: ${this.config.name}`);
      
    } catch (error) {
      console.error('索引优化失败:', error);
      throw error;
    } finally {
      this.isOptimizing = false;
      this.emit('optimization_completed');
    }
  }

  /**
   * 按时间戳分组日志到分片
   */
  private groupLogsByShards(logs: UnifiedLogEntry[]): Map<string, UnifiedLogEntry[]> {
    const shards = new Map<string, UnifiedLogEntry[]>();
    
    for (const log of logs) {
      const shardId = this.getShardId(log.timestamp);
      
      if (!shards.has(shardId)) {
        shards.set(shardId, []);
      }
      
      shards.get(shardId)!.push(log);
    }
    
    return shards;
  }

  /**
   * 获取分片ID
   */
  private getShardId(timestamp: number): string {
    const shardStart = Math.floor(timestamp / this.config.shardInterval) * this.config.shardInterval;
    const shardEnd = shardStart + this.config.shardInterval;
    return `${shardStart}-${shardEnd}`;
  }

  /**
   * 添加到分片
   */
  private async addToShard(shardId: string, entries: UnifiedLogEntry[]): Promise<void> {
    let shard = this.shards.get(shardId);
    
    if (!shard) {
      const [start, end] = shardId.split('-').map(Number);
      shard = {
        id: shardId,
        startTime: start,
        endTime: end,
        entries: [],
        count: 0,
        memoryUsage: 0,
        lastAccess: Date.now(),
        isCompressed: false
      };
      this.shards.set(shardId, shard);
    }
    
    // 添加到分片
    shard.entries.push(...entries);
    shard.count += entries.length;
    shard.lastAccess = Date.now();
    
    // 更新内存使用
    shard.memoryUsage = this.estimateShardMemory(shard);
    
    // 检查是否需要压缩
    if (this.config.enableCompression && shard.count > this.config.compressionThreshold) {
      await this.compressShard(shard);
    }
  }

  /**
   * 压缩分片
   */
  private async compressShard(shard: TimeShard): Promise<void> {
    if (shard.isCompressed) return;
    
    try {
      // 简化的压缩：移除重复和不必要的数据
      const uniqueEntries = this.deduplicateEntries(shard.entries);
      
      // 压缩前后对比
      const originalSize = shard.memoryUsage;
      shard.entries = uniqueEntries;
      shard.memoryUsage = this.estimateShardMemory(shard);
      shard.isCompressed = true;
      
      const compressionRatio = (originalSize - shard.memoryUsage) / originalSize;
      console.log(`压缩分片 ${shard.id}: 压缩率 ${(compressionRatio * 100).toFixed(1)}%`);
      
    } catch (error) {
      console.error(`压缩分片失败 ${shard.id}:`, error);
    }
  }

  /**
   * 去重日志条目
   */
  private deduplicateEntries(entries: UnifiedLogEntry[]): UnifiedLogEntry[] {
    const seen = new Set<string>();
    const unique: UnifiedLogEntry[] = [];
    
    for (const entry of entries) {
      // 基于关键字段生成唯一键
      const key = `${entry.timestamp}-${entry.moduleId}-${entry.level}-${entry.message}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(entry);
      }
    }
    
    return unique;
  }

  /**
   * 估算分片内存使用
   */
  private estimateShardMemory(shard: TimeShard): number {
    // 简化的内存估算
    const baseSize = 100; // 基础对象大小
    const entrySize = shard.entries.length * baseSize;
    const dataSize = JSON.stringify(shard.entries).length * 2; // UTF-16
    
    return entrySize + dataSize;
  }

  /**
   * 创建查询计划
   */
  private createQueryPlan(filter: LogFilter): { shards: string[]; plan: QueryPlan } {
    const shardIds: string[] = [];
    
    // 基于时间范围确定需要查询的分片
    if (filter.timeRange) {
      const startShard = this.getShardId(filter.timeRange.start);
      const endShard = this.getShardId(filter.timeRange.end);
      
      // 生成时间范围内的所有分片ID
      let currentTime = this.extractTimeFromShardId(startShard);
      const endTime = this.extractTimeFromShardId(endShard) + this.config.shardInterval;
      
      while (currentTime <= endTime) {
        const shardId = this.getShardId(currentTime);
        if (this.shards.has(shardId)) {
          shardIds.push(shardId);
        }
        currentTime += this.config.shardInterval;
      }
    } else {
      // 没有时间范围，查询所有分片
      shardIds.push(...this.shards.keys());
    }
    
    // 过滤不存在的分片
    const validShards = shardIds.filter(id => this.shards.has(id));
    
    const plan: QueryPlan = {
      shards: validShards,
      strategy: filter.timeRange ? 'time_range' : 'full_scan',
      estimatedTime: validShards.length * 10, // 估算查询时间
      estimatedMemory: validShards.length * 1000 // 估算内存使用
    };
    
    return { shards: validShards, plan };
  }

  /**
   * 执行查询计划
   */
  private async executeQueryPlan(
    optimizer: { shards: string[]; plan: QueryPlan },
    filter: LogFilter
  ): Promise<{ logs: UnifiedLogEntry[]; total: number }> {
    const allLogs: UnifiedLogEntry[] = [];
    
    for (const shardId of optimizer.shards) {
      const shard = this.shards.get(shardId);
      if (!shard) continue;
      
      // 更新最后访问时间
      shard.lastAccess = Date.now();
      
      // 解压缩（如果需要）
      if (shard.isCompressed) {
        await this.decompressShard(shard);
      }
      
      // 在分片内查询
      const shardLogs = this.queryShard(shard, filter);
      allLogs.push(...shardLogs);
    }
    
    // 应用过滤条件
    const filteredLogs = this.applyFilters(allLogs, filter);
    
    // 分页
    const offset = filter.offset || 0;
    const limit = filter.limit || filteredLogs.length;
    const paginatedLogs = filteredLogs.slice(offset, offset + limit);
    
    return {
      logs: paginatedLogs,
      total: filteredLogs.length
    };
  }

  /**
   * 在分片内查询
   */
  private queryShard(shard: TimeShard, filter: LogFilter): UnifiedLogEntry[] {
    let logs = [...shard.entries];
    
    // 时间范围过滤
    if (filter.timeRange) {
      logs = logs.filter(log => 
        log.timestamp >= filter.timeRange!.start && 
        log.timestamp <= filter.timeRange!.end
      );
    }
    
    return logs;
  }

  /**
   * 应用过滤器
   */
  private applyFilters(logs: UnifiedLogEntry[], filter: LogFilter): UnifiedLogEntry[] {
    let filtered = logs;
    
    // 级别过滤
    if (filter.levels && filter.levels.length > 0) {
      filtered = filtered.filter(log => filter.levels!.includes(log.level));
    }
    
    // 模块ID过滤
    if (filter.moduleIds && filter.moduleIds.length > 0) {
      filtered = filtered.filter(log => filter.moduleIds!.includes(log.moduleId));
    }
    
    // 模块类型过滤
    if (filter.moduleTypes && filter.moduleTypes.length > 0) {
      filtered = filtered.filter(log => filter.moduleTypes!.includes(log.moduleType));
    }
    
    // 关键词搜索
    if (filter.keyword) {
      const keyword = filter.keyword.toLowerCase();
      filtered = filtered.filter(log => 
        log.message.toLowerCase().includes(keyword) ||
        (log.data && JSON.stringify(log.data).toLowerCase().includes(keyword))
      );
    }
    
    // 错误过滤
    if (filter.hasError !== undefined) {
      filtered = filtered.filter(log => 
        filter.hasError ? !!log.error : !log.error
      );
    }
    
    return filtered;
  }

  /**
   * 解压缩分片
   */
  private async decompressShard(shard: TimeShard): Promise<void> {
    if (!shard.isCompressed) return;
    
    // 简化解压缩：这里只是标记为未压缩
    // 在实际实现中，这里需要真正的解压缩逻辑
    shard.isCompressed = false;
  }

  /**
   * 合并小分片
   */
  private async mergeSmallShards(): Promise<void> {
    const smallShards: TimeShard[] = [];
    
    for (const shard of this.shards.values()) {
      if (shard.count < 100) { // 小于100条日志的分片视为小分片
        smallShards.push(shard);
      }
    }
    
    if (smallShards.length < 2) return;
    
    // 按时间排序
    smallShards.sort((a, b) => a.startTime - b.startTime);
    
    // 合并相邻的小分片
    for (let i = 0; i < smallShards.length - 1; i++) {
      const current = smallShards[i];
      const next = smallShards[i + 1];
      
      if (next.startTime - current.endTime < this.config.shardInterval) {
        // 合并分片
        const mergedShard = this.mergeTwoShards(current, next);
        
        // 更新索引
        this.shards.delete(current.id);
        this.shards.delete(next.id);
        this.shards.set(mergedShard.id, mergedShard);
        
        i++; // 跳过下一个分片
      }
    }
  }

  /**
   * 合并两个分片
   */
  private mergeTwoShards(shard1: TimeShard, shard2: TimeShard): TimeShard {
    const mergedEntries = [...shard1.entries, ...shard2.entries];
    mergedEntries.sort((a, b) => a.timestamp - b.timestamp);
    
    return {
      id: this.getShardId(shard1.startTime), // 使用第一个分片的时间
      startTime: Math.min(shard1.startTime, shard2.startTime),
      endTime: Math.max(shard1.endTime, shard2.endTime),
      entries: mergedEntries,
      count: mergedEntries.length,
      memoryUsage: this.estimateShardMemory({ ...shard1, entries: mergedEntries }),
      lastAccess: Date.now(),
      isCompressed: false
    };
  }

  /**
   * 压缩大分片
   */
  private async compressLargeShards(): Promise<void> {
    for (const shard of this.shards.values()) {
      if (shard.count > this.config.compressionThreshold && !shard.isCompressed) {
        await this.compressShard(shard);
      }
    }
  }

  /**
   * 清理过期数据
   */
  private async cleanupExpiredData(): Promise<void> {
    const now = Date.now();
    const expiredShards: string[] = [];
    
    for (const [shardId, shard] of this.shards) {
      if (shard.lastAccess < now - this.config.ttl) {
        expiredShards.push(shardId);
      }
    }
    
    for (const shardId of expiredShards) {
      this.shards.delete(shardId);
    }
    
    if (expiredShards.length > 0) {
      console.log(`清理了 ${expiredShards.length} 个过期分片`);
    }
  }

  /**
   * 更新元数据
   */
  private updateMetadata(): void {
    this.rebuildMetadata();
  }

  /**
   * 重建元数据
   */
  private rebuildMetadata(): void {
    let totalEntries = 0;
    let startTime = Infinity;
    let endTime = -Infinity;
    const moduleDistribution: Record<string, number> = {};
    const levelDistribution: Record<string, number> = {};
    
    for (const shard of this.shards.values()) {
      totalEntries += shard.count;
      startTime = Math.min(startTime, shard.startTime);
      endTime = Math.max(endTime, shard.endTime);
      
      // 统计模块和级别分布（这里简化处理）
      for (const entry of shard.entries) {
        moduleDistribution[entry.moduleId] = (moduleDistribution[entry.moduleId] || 0) + 1;
        levelDistribution[entry.level] = (levelDistribution[entry.level] || 0) + 1;
      }
    }
    
    this.metadata = {
      ...this.metadata,
      lastUpdated: Date.now(),
      totalEntries,
      shardCount: this.shards.size,
      timeRange: startTime === Infinity ? { start: Date.now(), end: Date.now() } : { start: startTime, end: endTime },
      moduleDistribution,
      levelDistribution
    };
  }

  /**
   * 计算内存使用
   */
  private calculateMemoryUsage(): number {
    let totalMemory = 0;
    
    for (const shard of this.shards.values()) {
      totalMemory += shard.memoryUsage;
    }
    
    // 添加元数据内存使用
    totalMemory += JSON.stringify(this.metadata).length * 2;
    
    return totalMemory;
  }

  /**
   * 检查是否需要优化
   */
  private shouldOptimize(): boolean {
    const now = Date.now();
    const timeSinceLastOptimization = now - this.lastOptimization;
    
    // 每6小时优化一次
    return timeSinceLastOptimization > (6 * 60 * 60 * 1000);
  }

  /**
   * 设置定期维护
   */
  private setupPeriodicMaintenance(): void {
    // 每小时检查一次
    setInterval(() => {
      if (this.shouldOptimize()) {
        this.optimize().catch(error => {
          console.error('自动优化失败:', error);
        });
      }
    }, 60 * 60 * 1000);
  }

  /**
   * 从分片ID提取时间
   */
  private extractTimeFromShardId(shardId: string): number {
    return parseInt(shardId.split('-')[0]);
  }

  /**
   * 获取索引元数据
   */
  getMetadata(): IndexMetadata {
    return { ...this.metadata };
  }

  /**
   * 获取分片信息
   */
  getShardInfo(): TimeShard[] {
    return Array.from(this.shards.values()).map(shard => ({ ...shard }));
  }

  /**
   * 导出索引数据
   */
  async exportIndex(): Promise<string> {
    const exportData = {
      metadata: this.metadata,
      shards: Array.from(this.shards.entries()),
      config: this.config
    };
    
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * 导入索引数据
   */
  async importIndex(data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data);
      
      // 验证数据结构
      if (!parsed.metadata || !parsed.shards || !parsed.config) {
        throw new Error('Invalid index data format');
      }
      
      this.metadata = parsed.metadata;
      this.shards = new Map(parsed.shards);
      
      console.log(`导入索引成功: ${this.metadata.totalEntries} 条日志`);
      
    } catch (error) {
      console.error('导入索引失败:', error);
      throw error;
    }
  }
}

/**
 * 便捷的索引函数
 */
export function createTimeSeriesIndex(config: TimeSeriesIndexConfig): TimeSeriesIndexEngine {
  return new TimeSeriesIndexEngine(config);
}