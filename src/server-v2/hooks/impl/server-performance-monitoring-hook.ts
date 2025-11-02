/**
 * Server Performance Monitoring Hook
 *
 * 按照现有规范实现的性能监控Hook
 * 命名: server.03.performance-monitoring
 */

import type {
  IBidirectionalHook,
  HookExecutionContext,
  HookResult,
  HookDataPacket
} from '../../../modules/hooks/types/hook-types.js';
import {
  UnifiedHookStage
} from '../../../modules/hooks/types/hook-types.js';

/**
 * 性能指标接口
 */
interface PerformanceMetrics {
  requestId: string;
  endpoint: string;
  stage: string;
  timestamp: number;
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage?: NodeJS.CpuUsage;
  processingTime: number;
  dataSize: number;
}

/**
 * 性能监控数据存储
 */
class PerformanceMonitor {
  private metrics: Map<string, PerformanceMetrics[]> = new Map();
  private maxEntries: number = 1000;

  recordMetrics(metrics: PerformanceMetrics): void {
    const key = `${metrics.requestId}_${metrics.endpoint}`;
    const existing = this.metrics.get(key) || [];

    existing.push(metrics);

    // 保持最大条目数限制
    if (existing.length > this.maxEntries) {
      existing.splice(0, existing.length - this.maxEntries);
    }

    this.metrics.set(key, existing);
  }

  getMetrics(requestId: string, endpoint: string): PerformanceMetrics[] {
    const key = `${requestId}_${endpoint}`;
    return this.metrics.get(key) || [];
  }

  getAllMetrics(): PerformanceMetrics[] {
    const allMetrics: PerformanceMetrics[] = [];
    for (const metrics of this.metrics.values()) {
      allMetrics.push(...metrics);
    }
    return allMetrics;
  }

  clearMetrics(): void {
    this.metrics.clear();
  }

  getPerformanceSummary(): {
    totalRequests: number;
    avgProcessingTime: number;
    avgMemoryUsage: number;
    slowestRequest: { requestId: string; time: number } | null;
  } {
    const allMetrics = this.getAllMetrics();

    if (allMetrics.length === 0) {
      return {
        totalRequests: 0,
        avgProcessingTime: 0,
        avgMemoryUsage: 0,
        slowestRequest: null
      };
    }

    const totalProcessingTime = allMetrics.reduce((sum, m) => sum + m.processingTime, 0);
    const totalMemoryUsage = allMetrics.reduce((sum, m) => sum + m.memoryUsage.heapUsed, 0);
    const slowest = allMetrics.reduce((max, current) =>
      current.processingTime > max.processingTime ? current : max
    , allMetrics[0]);

    return {
      totalRequests: new Set(allMetrics.map(m => m.requestId)).size,
      avgProcessingTime: Math.round(totalProcessingTime / allMetrics.length * 100) / 100,
      avgMemoryUsage: Math.round(totalMemoryUsage / allMetrics.length),
      slowestRequest: {
        requestId: slowest.requestId,
        time: slowest.processingTime
      }
    };
  }
}

// 全局性能监控实例
const performanceMonitor = new PerformanceMonitor();

/**
 * Server性能监控Hook
 */
export class ServerPerformanceMonitoringHook implements IBidirectionalHook {
  readonly name = 'server.03.performance-monitoring';
  readonly stage: UnifiedHookStage = UnifiedHookStage.RESPONSE_VALIDATION;
  readonly priority = 30;
  readonly target = 'response' as const;
  readonly isDebugHook = true;

  async execute(context: HookExecutionContext, data: HookDataPacket): Promise<HookResult> {
    const startTime = Date.now();
    const processingTime = Date.now() - (context.startTime || startTime);

    // 计算数据大小
    const dataSize = this.calculateDataSize(data.data);

    // 记录性能指标
    const metrics: PerformanceMetrics = {
      requestId: context.requestId || 'unknown',
      endpoint: 'server-v2',
      stage: this.stage,
      timestamp: Date.now(),
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      processingTime,
      dataSize
    };

    performanceMonitor.recordMetrics(metrics);

    console.log(`[ServerPerformanceMonitoringHook] Performance metrics for ${context.requestId}:`, {
      processingTime: `${processingTime}ms`,
      memoryUsage: `${Math.round(metrics.memoryUsage.heapUsed / 1024 / 1024)}MB`,
      dataSize: `${Math.round(dataSize / 1024)}KB`
    });

    // 检查性能警告
    const warnings = this.checkPerformanceWarnings(metrics);
    if (warnings.length > 0) {
      console.warn(`[ServerPerformanceMonitoringHook] Performance warnings for ${context.requestId}:`, warnings);
    }

    // 在元数据中添加性能信息
    const enrichedMetadata = {
      performance: {
        processingTime,
        memoryUsage: metrics.memoryUsage,
        dataSize,
        warnings
      }
    };

    return {
      success: true,
      data: data.data, // 不修改原始数据
      metadata: enrichedMetadata,
      executionTime: Date.now() - startTime
    };
  }

  /**
   * 计算数据大小
   */
  private calculateDataSize(data: unknown): number {
    try {
      const jsonString = JSON.stringify(data);
      return Buffer.byteLength(jsonString, 'utf-8');
    } catch {
      return 0;
    }
  }

  /**
   * 检查性能警告
   */
  private checkPerformanceWarnings(metrics: PerformanceMetrics): string[] {
    const warnings: string[] = [];

    // 处理时间警告
    if (metrics.processingTime > 5000) { // 5秒
      warnings.push(`Slow processing: ${metrics.processingTime}ms`);
    }

    // 内存使用警告
    const memoryUsageMB = metrics.memoryUsage.heapUsed / 1024 / 1024;
    if (memoryUsageMB > 500) { // 500MB
      warnings.push(`High memory usage: ${Math.round(memoryUsageMB)}MB`);
    }

    // 数据大小警告
    const dataSizeKB = metrics.dataSize / 1024;
    if (dataSizeKB > 1024) { // 1MB
      warnings.push(`Large data size: ${Math.round(dataSizeKB)}KB`);
    }

    return warnings;
  }

  /**
   * 获取性能监控器实例
   */
  static getPerformanceMonitor(): PerformanceMonitor {
    return performanceMonitor;
  }

  /**
   * 获取性能统计
   */
  static getPerformanceStats() {
    return performanceMonitor.getPerformanceSummary();
  }
}