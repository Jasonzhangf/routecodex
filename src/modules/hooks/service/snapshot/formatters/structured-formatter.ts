/**
 * 结构化格式化器
 *
 * 提供人类可读的结构化格式，优化调试和分析体验
 */

import type { SnapshotData, HookExecutionResult } from '../../../types/hook-types.js';
import type { SnapshotFormatter } from './json-formatter.js';

/**
 * 结构化格式化器实现
 */
export class StructuredFormatter implements SnapshotFormatter {
  private includeRawData: boolean;
  private maxDataSize: number;

  constructor(options: {
    includeRawData?: boolean;
    maxDataSize?: number;
  } = {}) {
    this.includeRawData = options.includeRawData !== false;
    this.maxDataSize = options.maxDataSize || 1024 * 10; // 10KB
  }

  /**
   * 格式化快照数据为结构化格式
   */
  format(data: SnapshotData): string {
    const structured = this.createStructuredView(data);
    return JSON.stringify(structured, null, 2);
  }

  /**
   * 获取文件扩展名
   */
  getFileExtension(): string {
    return 'structured.json';
  }

  /**
   * 获取MIME类型
   */
  getMimeType(): string {
    return 'application/json';
  }

  /**
   * 创建结构化视图
   */
  private createStructuredView(data: SnapshotData): unknown {
    return {
      // 快照元信息
      snapshot: {
        id: data.metadata.snapshotId,
        module: data.metadata.moduleId,
        request: data.metadata.requestId,
        stage: data.metadata.stage,
        timestamp: new Date(data.metadata.timestamp).toISOString(),
        format: data.metadata.format,
        compression: data.metadata.compression
      },

      // 执行摘要
      summary: {
        ...data.summary,
        duration: `${data.summary.totalExecutionTime}ms`,
        successRate: data.summary.totalHooks > 0
          ? `${Math.round((data.summary.successfulHooks / data.summary.totalHooks) * 100)}%`
          : 'N/A'
      },

      // Hook执行详情
      execution: {
        context: {
          executionId: data.executionContext.executionId,
          startTime: new Date(data.executionContext.startTime).toISOString(),
          moduleId: data.executionContext.moduleId,
          stage: data.executionContext.stage
        },
        hooks: this.formatHooks(data.hooks)
      },

      // 原始数据（可选）
      rawData: this.includeRawData ? this.truncateData(data) : undefined
    };
  }

  /**
   * 格式化Hook执行结果
   */
  private formatHooks(hooks: HookExecutionResult[]): unknown[] {
    return hooks.map(hook => ({
      // 基本信息
      name: hook.hookName,
      stage: hook.stage,
      target: hook.target,
      priority: this.extractPriority(hook),

      // 执行结果
      result: {
        success: hook.success,
        duration: `${hook.executionTime}ms`,
        hasData: hook.data !== undefined,
        hasChanges: hook.changes && hook.changes.length > 0,
        observations: hook.observations || []
      },

      // 数据变更（如果有）
      changes: hook.changes && hook.changes.length > 0 ? {
        count: hook.changes.length,
        types: [...new Set(hook.changes.map(c => c.type))],
        paths: [...new Set(hook.changes.map(c => c.path))]
      } : undefined,

      // 错误信息（如果有）
      error: hook.error ? {
        type: hook.error.constructor?.name || 'Error',
        message: hook.error.message
      } : undefined,

      // 指标（如果有）
      metrics: hook.metrics
    }));
  }

  /**
   * 提取优先级（占位符实现）
   */
  private extractPriority(_hook: HookExecutionResult): number {
    // 这里应该从Hook注册信息中获取优先级
    // 暂时返回默认值
    return 100;
  }

  /**
   * 截断数据以避免文件过大
   */
  private truncateData(data: SnapshotData): unknown {
    const dataStr = JSON.stringify(data);
    if (dataStr.length <= this.maxDataSize) {
      return data;
    }

    // 截断Hook数据
    const truncated = { ...data };
    if (truncated.hooks) {
      truncated.hooks = truncated.hooks.map(hook => ({
        ...hook,
        data: this.truncateValue(hook.data),
        observations: hook.observations ? hook.observations.slice(0, 10) : undefined
      }));
    }

    return {
      ...truncated,
      _truncated: {
        originalSize: dataStr.length,
        truncatedSize: JSON.stringify(truncated).length,
        reason: 'Size limit exceeded'
      }
    };
  }

  /**
   * 截断单个值
   */
  private truncateValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      if (value.length > 1000) {
        return `${value.substring(0, 1000)  }...[truncated]`;
      }
      return value;
    }

    if (typeof value === 'object') {
      try {
        const str = JSON.stringify(value);
        if (str.length > 2000) {
          return '[Object too large to display]';
        }
        return value;
      } catch {
        return '[Non-serializable object]';
      }
    }

    return value;
  }

  /**
   * 创建默认结构化格式化器
   */
  static createDefault(): StructuredFormatter {
    return new StructuredFormatter();
  }

  /**
   * 创建精简结构化格式化器
   */
  static createCompact(): StructuredFormatter {
    return new StructuredFormatter({
      includeRawData: false,
      maxDataSize: 1024 * 5 // 5KB
    });
  }

  /**
   * 创建详细结构化格式化器
   */
  static createDetailed(): StructuredFormatter {
    return new StructuredFormatter({
      includeRawData: true,
      maxDataSize: 1024 * 50 // 50KB
    });
  }
}