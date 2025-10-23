/**
 * 简化的时间序列索引系统
 * 
 * 只提供基本的日志存储功能，移除所有复杂特性
 */

import { EventEmitter } from 'events';

import type { 
  UnifiedLogEntry, 
  LogFilter, 
  LogQueryResult,
  IndexStatus 
} from '../types.js';
import type { LogQueryEngine } from '../interfaces.js';

/**
 * 简化的索引配置
 */
export interface SimpleTimeSeriesIndexConfig {
  /** 索引名称 */
  name: string;
  /** 最大存储条目数（简单限制） */
  maxEntries?: number;
}

/**
 * 简化的时间序列索引器
 * 只提供基本的日志存储，移除所有复杂功能
 */
export class SimpleTimeSeriesIndexer extends EventEmitter implements LogQueryEngine {
  private config: Required<SimpleTimeSeriesIndexConfig>;
  private entries: UnifiedLogEntry[] = [];
  private stats = {
    totalEntries: 0,
    memoryUsage: 0
  };

  constructor(config: SimpleTimeSeriesIndexConfig) {
    super();
    
    this.config = {
      name: config.name,
      maxEntries: config.maxEntries || 1000 // 简单的默认限制
    };
  }

  /**
   * 添加日志条目（简化版）
   */
  async index(logs: UnifiedLogEntry[]): Promise<void> {
    // 简单的添加，不做复杂处理
    this.entries.push(...logs);
    this.stats.totalEntries += logs.length;
    
    // 简单的内存使用估算
    this.stats.memoryUsage = this.entries.length * 100; // 粗略估算
    
    // 如果超过最大条目数，简单地截断（可以优化为移除最旧的）
    if (this.entries.length > this.config.maxEntries) {
      this.entries = this.entries.slice(-this.config.maxEntries);
    }
    
    this.emit('indexed', { count: logs.length });
  }

  /**
   * 查询日志（简化版）
   */
  async query(filter: LogFilter): Promise<LogQueryResult> {
    const startTime = Date.now();
    
    // 简单的过滤逻辑
    let filteredLogs = [...this.entries];
    
    // 基本的时间范围过滤
    if (filter.timeRange) {
      filteredLogs = filteredLogs.filter(log => 
        log.timestamp >= filter.timeRange!.start && 
        log.timestamp <= filter.timeRange!.end
      );
    }
    
    // 基本的日志级别过滤
    if (filter.levels && filter.levels.length > 0) {
      filteredLogs = filteredLogs.filter(log => 
        filter.levels!.includes(log.level)
      );
    }
    
    // 基本的模块ID过滤
    if (filter.moduleIds && filter.moduleIds.length > 0) {
      filteredLogs = filteredLogs.filter(log => 
        filter.moduleIds!.includes(log.moduleId)
      );
    }
    
    const queryTime = Date.now() - startTime;
    
    return {
      logs: filteredLogs,
      total: this.entries.length,
      filter,
      queryTime
    };
  }

  /**
   * 从索引中移除日志
   */
  async remove(_index: string): Promise<void> {
    // 简化实现：清空所有日志
    await this.clear();
  }

  /**
   * 获取索引状态
   */
  getIndexStatus(): IndexStatus {
    return {
      name: this.config.name,
      documentCount: this.stats.totalEntries,
      size: this.stats.memoryUsage,
      lastCheck: Date.now(),
      lastUpdate: Date.now(),
      status: 'active'
    };
  }

  /**
   * 优化索引
   */
  async optimize(): Promise<void> {
    // 简化实现：触发内存回收
    if (global.gc) {
      global.gc();
    }
  }

  /**
   * 获取索引状态（简化版）- 向后兼容
   */
  getStatus(): IndexStatus {
    return this.getIndexStatus();
  }

  /**
   * 清理索引（简化版）
   */
  async clear(): Promise<void> {
    this.entries = [];
    this.stats = {
      totalEntries: 0,
      memoryUsage: 0
    };
    this.emit('cleared');
  }

  /**
   * 销毁索引器
   */
  async destroy(): Promise<void> {
    await this.clear();
    this.removeAllListeners();
  }
}

// 导出简化版本作为默认实现
export const TimeSeriesIndexer = SimpleTimeSeriesIndexer;